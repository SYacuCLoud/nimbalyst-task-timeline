import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

const h = React.createElement;
const DAY = 86400000;
const ROW = 32;
const HEADER = 48;
const LEFT = 300;
const ZOOMS = {
  day: { label: "일", px: 36 },
  week: { label: "주", px: 14 },
  month: { label: "월", px: 4 },
};
const STATUS = {
  "to-do": { label: "To Do", color: "#94a3b8" },
  "in-progress": { label: "In Progress", color: "#3b82f6" },
  "in-review": { label: "In Review", color: "#6366f1" },
  "changes-requested": { label: "Changes Requested", color: "#f97316" },
  approved: { label: "Approved", color: "#22c55e" },
  done: { label: "Done", color: "#16a34a" },
  "wont-do": { label: "Won't Do", color: "#64748b" },
  duplicate: { label: "Duplicate", color: "#64748b" },
  planned: { label: "Planned", color: "#94a3b8" },
  active: { label: "Active", color: "#eab308" },
  cancelled: { label: "Cancelled", color: "#64748b" },
};
const CLOSED = new Set(["done", "wont-do", "duplicate", "cancelled", "completed", "released", "rejected"]);
const PRIORITY_ORDER = ["critical", "high", "medium", "low"];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// ---------- date helpers (local midnight, day granularity) ----------
function parseDate(v) {
  if (!v || typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function diffDays(a, b) {
  return Math.round((a - b) / DAY);
}
function fmt(d) {
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : "–";
}
function fmtFull(d) {
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "–";
}

function parseJson(v) {
  if (v == null) return {};
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v) || {};
  } catch {
    return {};
  }
}
function ownerName(o) {
  if (!o) return "";
  if (typeof o === "string") return o;
  return o.displayName || o.name || o.email || "";
}

// ---------- tracker write bridge ----------
// The extension SDK only exposes reads (host.data.query). Creating items uses
// the renderer IPC that Nimbalyst's own tracker UI uses. It is internal and
// may change between app versions, so every call checks it exists first.
function electronApi() {
  const api = typeof window !== "undefined" ? window.electronAPI : null;
  return api && typeof api.invoke === "function" ? api : null;
}
function canCreateItems() {
  return typeof electronApi()?.documentService?.createTrackerItem === "function";
}

const FALLBACK_TYPES = [
  {
    type: "task",
    displayName: "Task",
    idPrefix: "tsk",
    defaultStatus: "to-do",
    startField: "startDate",
    dueField: "dueDate",
    priorities: ["low", "medium", "high", "critical"],
    defaultPriority: "medium",
  },
];

function toTypeInfo(m) {
  const byRole = (role, fallback) => {
    const name = m.roles?.[role] ?? fallback;
    return (m.fields || []).find((f) => f.name === name);
  };
  const dateName = (f) => (f && (f.type === "date" || f.type === "datetime") ? f.name : null);
  const status = byRole("workflowStatus", "status");
  const priority = byRole("priority", "priority");
  return {
    type: m.type,
    displayName: m.displayName || m.type,
    idPrefix: m.idPrefix || m.type.slice(0, 3),
    creatable: m.creatable !== false,
    defaultStatus: typeof status?.default === "string" ? status.default : status?.options?.[0]?.value,
    startField: dateName(byRole("startDate", "startDate")),
    dueField: dateName(byRole("dueDate", "dueDate")),
    priorities: (priority?.options || []).map((o) => o.value),
    defaultPriority: typeof priority?.default === "string" ? priority.default : undefined,
  };
}

async function loadCreatableTypes() {
  const api = electronApi();
  if (!api) return FALLBACK_TYPES;
  try {
    const raw = await api.invoke("tracker-schema:get-all");
    if (!Array.isArray(raw)) return FALLBACK_TYPES;
    const types = raw
      .filter((m) => m && typeof m.type === "string")
      .map(toTypeInfo)
      .filter((t) => t.creatable && (t.startField || t.dueField));
    return types.length ? types : FALLBACK_TYPES;
  } catch {
    return FALLBACK_TYPES;
  }
}

function newItemId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

async function createItem(host, typeInfo, input) {
  const ds = electronApi()?.documentService;
  if (!ds?.createTrackerItem) throw new Error("이 Nimbalyst 버전에서는 항목을 만들 수 없습니다.");
  const customFields = {};
  if (input.start && typeInfo.startField) customFields[typeInfo.startField] = input.start;
  if (input.due && typeInfo.dueField) customFields[typeInfo.dueField] = input.due;
  const id = newItemId(typeInfo.idPrefix);
  const result = await ds.createTrackerItem({
    id,
    type: typeInfo.type,
    title: input.title.trim(),
    status: typeInfo.defaultStatus,
    priority: input.priority || undefined,
    workspace: host.workspacePath,
    customFields,
  });
  if (result && result.success === false) throw new Error(result.error || "항목 생성에 실패했습니다.");
  return result?.item?.id || id;
}

function openTrackerItem(itemId) {
  window.dispatchEvent(new CustomEvent("nimbalyst:navigate-tracker-item", { detail: { itemId } }));
}

// ---------- data ----------
async function loadData(host) {
  const ws = host.workspacePath;
  const rows = await host.data.query(
    `SELECT id, issue_key, type, data, archived
       FROM tracker_items
      WHERE workspace = $1
        AND deleted_at IS NULL`,
    [ws]
  );
  let rels = [];
  try {
    rels = await host.data.query(
      `SELECT source_item_id, target_item_id
         FROM tracker_relationship_index
        WHERE workspace = $1
          AND source_field_id = 'dependsOn'`,
      [ws]
    );
  } catch {
    rels = [];
  }
  const items = [];
  for (const r of rows) {
    if (r.archived === true || r.archived === 1) continue;
    const d = parseJson(r.data);
    const isMilestone = r.type === "milestone";
    const start = parseDate(d.startDate);
    const due = parseDate(isMilestone ? d.targetDate || d.dueDate : d.dueDate);
    items.push({
      id: r.id,
      key: r.issue_key || "",
      type: r.type,
      title: d.title || "(제목 없음)",
      status: d.status || "",
      priority: d.priority || "",
      owner: ownerName(d.owner),
      start,
      due,
      isMilestone,
      byAgent: d.createdByAgent === true,
    });
  }
  const deps = rels.map((r) => ({ from: r.target_item_id, to: r.source_item_id }));
  return { items, deps };
}

// ---------- header ticks ----------
function buildTicks(origin, days, zoom) {
  const top = [];
  const bottom = [];
  const px = ZOOMS[zoom].px;
  let cur = null;
  for (let i = 0; i < days; i++) {
    const d = addDays(origin, i);
    const topKey = zoom === "month" ? d.getFullYear() : `${d.getFullYear()}-${d.getMonth()}`;
    if (!cur || cur.key !== topKey) {
      cur = { key: topKey, x: i * px, w: 0, label: zoom === "month" ? `${d.getFullYear()}년` : `${d.getFullYear()}년 ${d.getMonth() + 1}월` };
      top.push(cur);
    }
    cur.w += px;
    if (zoom === "day") {
      bottom.push({ x: i * px, w: px, label: `${d.getDate()}`, sub: WEEKDAYS[d.getDay()], weekend: d.getDay() === 0 || d.getDay() === 6 });
    } else if (zoom === "week" && d.getDay() === 1) {
      bottom.push({ x: i * px, w: 7 * px, label: `${d.getMonth() + 1}/${d.getDate()}` });
    } else if (zoom === "month" && d.getDate() === 1) {
      const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      bottom.push({ x: i * px, w: dim * px, label: `${d.getMonth() + 1}월` });
    }
  }
  return { top, bottom };
}

function groupKey(item, by) {
  if (by === "status") return STATUS[item.status]?.label || item.status || "(없음)";
  if (by === "owner") return item.owner || "(담당자 없음)";
  if (by === "priority") return item.priority || "(없음)";
  if (by === "type") return item.type;
  return "";
}
function groupSort(by) {
  if (by === "priority") return (a, b) => PRIORITY_ORDER.indexOf(a) - PRIORITY_ORDER.indexOf(b);
  if (by === "status") {
    const order = Object.values(STATUS).map((s) => s.label);
    return (a, b) => order.indexOf(a) - order.indexOf(b);
  }
  return (a, b) => a.localeCompare(b);
}

// ---------- component ----------
function TimelinePanel({ host }) {
  const [data, setData] = useState({ items: [], deps: [] });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState("day");
  const [groupBy, setGroupBy] = useState("none");
  const [typeFilter, setTypeFilter] = useState("task");
  const [showClosed, setShowClosed] = useState(true);
  const [showUndated, setShowUndated] = useState(true);
  const [showAgent, setShowAgent] = useState(true);
  const scrollRef = useRef(null);
  const didScroll = useRef(false);
  const titleRef = useRef(null);
  const canCreate = canCreateItems();
  const [createTypes, setCreateTypes] = useState(FALLBACK_TYPES);
  const [form, setForm] = useState(null); // { title, type, start, due, priority, saving, error }
  const [drag, setDrag] = useState(null); // { a, b } day offsets from origin

  useEffect(() => {
    if (canCreate) loadCreatableTypes().then(setCreateTypes);
  }, [canCreate]);

  const openForm = useCallback(
    (preset = {}) => {
      const t = createTypes.find((x) => x.type === (preset.type || "task")) || createTypes[0];
      setForm({
        title: "",
        type: t.type,
        start: preset.start || "",
        due: preset.due || "",
        priority: t.defaultPriority || "",
        saving: false,
        error: null,
      });
    },
    [createTypes]
  );

  useEffect(() => {
    if (form && !form.saving) titleRef.current?.focus();
  }, [form?.type, !!form]);

  const refresh = useCallback(async () => {
    if (!host?.data?.query) {
      setError("데이터베이스 읽기 권한이 없습니다. 확장 권한(Read Nimbalyst database)을 허용해 주세요.");
      setLoading(false);
      return;
    }
    try {
      setData(await loadData(host));
      setError(null);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const submitForm = useCallback(
    async (e) => {
      e?.preventDefault?.();
      if (!form || form.saving) return;
      const typeInfo = createTypes.find((x) => x.type === form.type) || createTypes[0];
      if (!form.title.trim()) return setForm({ ...form, error: "제목을 입력해 주세요." });
      if (form.start && form.due && form.due < form.start)
        return setForm({ ...form, error: "마감일이 시작일보다 빠릅니다." });
      setForm({ ...form, saving: true, error: null });
      try {
        await createItem(host, typeInfo, form);
        await refresh();
        // keep the form open with the same dates so several items can be added in a row
        setForm((f) => f && { ...f, title: "", saving: false, error: null });
      } catch (err) {
        setForm((f) => f && { ...f, saving: false, error: String(err?.message || err) });
      }
    },
    [form, createTypes, host, refresh]
  );

  const types = useMemo(() => Array.from(new Set(data.items.map((i) => i.type))).sort(), [data]);

  const visible = useMemo(
    () =>
      data.items.filter((i) => {
        if (typeFilter !== "all" && i.type !== typeFilter && !(typeFilter === "task" && i.isMilestone)) return false;
        if (!showClosed && CLOSED.has(i.status)) return false;
        if (!showAgent && i.byAgent) return false;
        return true;
      }),
    [data, typeFilter, showClosed, showAgent]
  );

  const dated = visible.filter((i) => i.start || i.due);
  const undated = visible.filter((i) => !i.start && !i.due && !i.isMilestone);

  // time range
  const now = today();
  const { origin, days } = useMemo(() => {
    let min = addDays(now, -7);
    let max = addDays(now, 30);
    for (const i of dated) {
      for (const d of [i.start, i.due]) {
        if (!d) continue;
        if (d < min) min = d;
        if (d > max) max = d;
      }
    }
    const o = addDays(min, -7);
    return { origin: o, days: diffDays(addDays(max, 14), o) + 1 };
  }, [dated, now.getTime()]);

  const px = ZOOMS[zoom].px;
  const width = days * px;
  const ticks = useMemo(() => buildTicks(origin, days, zoom), [origin, days, zoom]);

  // rows
  const rows = useMemo(() => {
    const out = [];
    const sortItems = (arr) =>
      arr.slice().sort((a, b) => {
        if (a.isMilestone !== b.isMilestone) return a.isMilestone ? -1 : 1;
        const as = a.start || a.due, bs = b.start || b.due;
        return as - bs || a.title.localeCompare(b.title);
      });
    if (groupBy === "none") {
      for (const i of sortItems(dated)) out.push({ kind: "item", item: i });
    } else {
      const groups = new Map();
      for (const i of dated) {
        const k = i.isMilestone ? "◆ 마일스톤" : groupKey(i, groupBy);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(i);
      }
      const cmp = groupSort(groupBy);
      const keys = Array.from(groups.keys()).sort((a, b) => (a === "◆ 마일스톤" ? -1 : b === "◆ 마일스톤" ? 1 : cmp(a, b)));
      for (const k of keys) {
        out.push({ kind: "group", label: k, count: groups.get(k).length });
        for (const i of sortItems(groups.get(k))) out.push({ kind: "item", item: i });
      }
    }
    if (showUndated && undated.length) {
      out.push({ kind: "group", label: "날짜 미지정", count: undated.length });
      for (const i of undated) out.push({ kind: "item", item: i });
    }
    return out;
  }, [dated, undated, groupBy, showUndated]);

  const xOf = (d) => diffDays(d, origin) * px;
  const barGeom = (i) => {
    if (i.isMilestone) {
      const d = i.due || i.start;
      return d ? { x: xOf(d) + px / 2, milestone: true } : null;
    }
    if (!i.start && !i.due) return null;
    const s = i.start || i.due;
    const e = i.due || i.start;
    const x1 = xOf(s);
    const x2 = xOf(e) + px;
    return { x: x1, w: Math.max(x2 - x1, 6), partial: !i.start || !i.due };
  };

  // drag on the "add" lane to pick a date range for a new item
  const dragLane = useRef(null);
  const dayAt = (clientX) => {
    const r = dragLane.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.min(days - 1, Math.floor((clientX - r.left) / px)));
  };
  const dragRef = useRef(null);
  const updateDrag = (g) => {
    dragRef.current = g;
    setDrag(g);
  };
  const onAddLaneDown = (e) => {
    if (e.button !== 0) return;
    dragLane.current = e.currentTarget;
    const d = dayAt(e.clientX);
    updateDrag({ a: d, b: d });
    e.preventDefault();
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e) => dragRef.current && updateDrag({ ...dragRef.current, b: dayAt(e.clientX) });
    const up = () => {
      const g = dragRef.current;
      updateDrag(null);
      if (!g) return;
      const lo = Math.min(g.a, g.b), hi = Math.max(g.a, g.b);
      const start = fmtFull(addDays(origin, lo)), due = fmtFull(addDays(origin, hi));
      if (form) setForm({ ...form, start, due, error: null });
      else openForm({ start, due });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [!!drag, origin, px, days, form, openForm]);

  const rowIndex = new Map();
  rows.forEach((r, idx) => r.kind === "item" && rowIndex.set(r.item.id, idx));

  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, xOf(now) - (el.clientWidth - LEFT) / 3);
  }, [origin, px]);

  useEffect(() => {
    if (!loading && !didScroll.current) {
      didScroll.current = true;
      scrollToToday();
    }
  }, [loading, scrollToToday]);
  useEffect(() => {
    scrollToToday();
  }, [zoom]);

  // dependency arrows
  const arrows = [];
  for (const dep of data.deps) {
    const a = rowIndex.get(dep.from);
    const b = rowIndex.get(dep.to);
    if (a == null || b == null) continue;
    const ga = barGeom(rows[a].item);
    const gb = barGeom(rows[b].item);
    if (!ga || !gb) continue;
    const x1 = ga.milestone ? ga.x + 7 : ga.x + ga.w;
    const y1 = a * ROW + ROW / 2;
    const x2 = gb.milestone ? gb.x - 7 : gb.x;
    const y2 = b * ROW + ROW / 2;
    const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 12));
    const late = x2 < x1;
    arrows.push(
      h("path", {
        key: `${dep.from}-${dep.to}`,
        d: `M${x1},${y1} H${mid} V${y2} H${x2 - 2}`,
        className: late ? "tt-arrow tt-arrow-late" : "tt-arrow",
        markerEnd: late ? "url(#tt-head-late)" : "url(#tt-head)",
      })
    );
  }

  const bodyHeight = rows.length * ROW;
  const todayX = xOf(now) + px / 2;

  // ---------- render ----------
  const toolbar = h(
    "div",
    { className: "tt-toolbar" },
    h("strong", { className: "tt-title" }, "Timeline"),
    canCreate ? h("button", { className: "tt-btn tt-primary", onClick: () => (form ? setForm(null) : openForm()) }, form ? "닫기" : "+ 새 항목") : null,
    h(
      "div",
      { className: "tt-seg" },
      Object.entries(ZOOMS).map(([k, z]) =>
        h("button", { key: k, className: zoom === k ? "on" : "", onClick: () => setZoom(k) }, z.label)
      )
    ),
    h("button", { className: "tt-btn", onClick: scrollToToday }, "오늘"),
    h(
      "label",
      { className: "tt-field" },
      "그룹",
      h(
        "select",
        { value: groupBy, onChange: (e) => setGroupBy(e.target.value) },
        h("option", { value: "none" }, "없음"),
        h("option", { value: "status" }, "상태"),
        h("option", { value: "owner" }, "담당자"),
        h("option", { value: "priority" }, "우선순위"),
        h("option", { value: "type" }, "타입")
      )
    ),
    h(
      "label",
      { className: "tt-field" },
      "타입",
      h(
        "select",
        { value: typeFilter, onChange: (e) => setTypeFilter(e.target.value) },
        h("option", { value: "task" }, "Task + Milestone"),
        h("option", { value: "all" }, "전체"),
        types.filter((t) => t !== "task").map((t) => h("option", { key: t, value: t }, t))
      )
    ),
    h("label", { className: "tt-check" }, h("input", { type: "checkbox", checked: showClosed, onChange: (e) => setShowClosed(e.target.checked) }), "완료 포함"),
    h("label", { className: "tt-check" }, h("input", { type: "checkbox", checked: showAgent, onChange: (e) => setShowAgent(e.target.checked) }), "에이전트 작업"),
    h("label", { className: "tt-check" }, h("input", { type: "checkbox", checked: showUndated, onChange: (e) => setShowUndated(e.target.checked) }), "날짜 미지정 표시"),
    h("span", { className: "tt-spacer" }),
    h("span", { className: "tt-count" }, `${dated.length}개 일정 · ${undated.length}개 미지정`),
    h("button", { className: "tt-btn", onClick: refresh, title: "새로고침" }, "↻")
  );

  const formType = form && (createTypes.find((x) => x.type === form.type) || createTypes[0]);
  const formBar = form
    ? h(
        "form",
        {
          className: "tt-form",
          onSubmit: submitForm,
          onKeyDown: (e) => e.key === "Escape" && setForm(null),
        },
        h(
          "select",
          {
            value: form.type,
            disabled: form.saving,
            onChange: (e) => {
              const t = createTypes.find((x) => x.type === e.target.value);
              setForm({ ...form, type: e.target.value, priority: t?.defaultPriority || "" });
            },
          },
          createTypes.map((t) => h("option", { key: t.type, value: t.type }, t.displayName))
        ),
        h("input", {
          ref: titleRef,
          className: "tt-form-title",
          placeholder: "제목 (Enter로 추가, Esc로 닫기)",
          value: form.title,
          disabled: form.saving,
          onChange: (e) => setForm({ ...form, title: e.target.value, error: null }),
        }),
        formType?.startField
          ? h(
              "label",
              { className: "tt-field" },
              "시작",
              h("input", { type: "date", value: form.start, disabled: form.saving, onChange: (e) => setForm({ ...form, start: e.target.value, error: null }) })
            )
          : null,
        formType?.dueField
          ? h(
              "label",
              { className: "tt-field" },
              formType.dueField === "dueDate" ? "마감" : "목표",
              h("input", { type: "date", value: form.due, disabled: form.saving, onChange: (e) => setForm({ ...form, due: e.target.value, error: null }) })
            )
          : null,
        formType?.priorities?.length
          ? h(
              "select",
              { value: form.priority, disabled: form.saving, onChange: (e) => setForm({ ...form, priority: e.target.value }) },
              h("option", { value: "" }, "우선순위 없음"),
              formType.priorities.map((p) => h("option", { key: p, value: p }, p))
            )
          : null,
        h("button", { type: "submit", className: "tt-btn tt-primary", disabled: form.saving }, form.saving ? "추가 중…" : "추가"),
        form.error ? h("span", { className: "tt-form-err" }, form.error) : h("span", { className: "tt-form-hint" }, "타임라인 맨 아래 줄을 드래그해도 기간이 채워집니다")
      )
    : null;

  if (error) return h("div", { className: "tt-root" }, toolbar, h("div", { className: "tt-msg tt-err" }, error));
  if (loading) return h("div", { className: "tt-root" }, toolbar, h("div", { className: "tt-msg" }, "불러오는 중…"));

  const header = h(
    "div",
    { className: "tt-header", style: { width: LEFT + width } },
    h("div", { className: "tt-left tt-left-head" }, h("span", null, "항목"), h("span", { className: "tt-dates-col" }, "시작 → 마감")),
    h(
      "div",
      { className: "tt-scale", style: { width } },
      ticks.top.map((t) => h("div", { key: "t" + t.x, className: "tt-tick-top", style: { left: t.x, width: t.w } }, t.label)),
      ticks.bottom.map((t) =>
        h(
          "div",
          { key: "b" + t.x, className: "tt-tick-bottom" + (t.weekend ? " weekend" : ""), style: { left: t.x, width: t.w } },
          t.label,
          t.sub ? h("small", null, t.sub) : null
        )
      )
    )
  );

  const rowEls = rows.map((r, idx) => {
    if (r.kind === "group") {
      return h(
        "div",
        { key: "g" + idx, className: "tt-row tt-group", style: { width: LEFT + width } },
        h("div", { className: "tt-left" }, h("span", null, r.label), h("span", { className: "tt-badge" }, r.count)),
        h("div", { className: "tt-lane", style: { width } })
      );
    }
    const i = r.item;
    const st = STATUS[i.status] || { label: i.status, color: "#94a3b8" };
    const closed = CLOSED.has(i.status);
    const overdue = !closed && i.due && i.due < now;
    const g = barGeom(i);
    const tip = `${i.title}\n상태: ${st.label}${i.owner ? `\n담당: ${i.owner}` : ""}${i.priority ? `\n우선순위: ${i.priority}` : ""}\n시작: ${fmtFull(i.start)}\n마감: ${fmtFull(i.due)}${overdue ? "\n⚠ 마감 지남" : ""}`;
    const open = () => openTrackerItem(i.id);
    let bar = null;
    if (g?.milestone) {
      bar = h("div", { className: "tt-diamond", style: { left: g.x - 7, background: st.color }, title: tip, onClick: open });
    } else if (g) {
      bar = h(
        "div",
        {
          key: "bar",
          className: "tt-bar" + (closed ? " closed" : "") + (overdue ? " overdue" : "") + (g.partial ? " partial" : ""),
          style: { left: g.x, width: g.w, background: st.color },
          title: tip,
          onClick: open,
        },
        g.w > 60 ? h("span", null, i.title) : null
      );
      if (g.w <= 60) bar = [bar, h("span", { key: "lbl", className: "tt-bar-label", style: { left: g.x + g.w + 6 } }, i.title)];
    }
    return h(
      "div",
      { key: i.id, className: "tt-row", style: { width: LEFT + width } },
      h(
        "div",
        { className: "tt-left tt-clickable", title: tip + "\n(클릭해서 열기)", onClick: open },
        h("span", { className: "tt-dot", style: { background: st.color } }),
        h("span", { className: "tt-name" + (closed ? " closed" : "") }, i.isMilestone ? "◆ " + i.title : i.title),
        i.owner ? h("span", { className: "tt-owner" }, i.owner) : null,
        h("span", { className: "tt-dates-col" + (overdue ? " overdue" : "") }, i.start || i.due ? `${fmt(i.start)} → ${fmt(i.due)}` : "")
      ),
      h("div", { className: "tt-lane", style: { width } }, bar)
    );
  });

  const weekendShade =
    zoom === "day"
      ? ticks.bottom.filter((t) => t.weekend).map((t) => h("rect", { key: "w" + t.x, x: t.x, y: 0, width: t.w, height: bodyHeight, className: "tt-weekend" }))
      : null;

  const overlay = h(
    "svg",
    { className: "tt-overlay", width, height: bodyHeight, style: { left: LEFT, top: HEADER } },
    h(
      "defs",
      null,
      h("marker", { id: "tt-head", markerWidth: 8, markerHeight: 8, refX: 6, refY: 4, orient: "auto" }, h("path", { d: "M0,0 L8,4 L0,8 z", className: "tt-arrowhead" })),
      h("marker", { id: "tt-head-late", markerWidth: 8, markerHeight: 8, refX: 6, refY: 4, orient: "auto" }, h("path", { d: "M0,0 L8,4 L0,8 z", className: "tt-arrowhead-late" }))
    ),
    weekendShade,
    h("line", { x1: todayX, x2: todayX, y1: 0, y2: bodyHeight, className: "tt-today" }),
    arrows
  );

  const ghost = drag
    ? h("div", {
        className: "tt-ghost",
        style: { left: Math.min(drag.a, drag.b) * px, width: (Math.abs(drag.b - drag.a) + 1) * px },
      }, `${fmt(addDays(origin, Math.min(drag.a, drag.b)))} → ${fmt(addDays(origin, Math.max(drag.a, drag.b)))}`)
    : null;
  const addRow = canCreate
    ? h(
        "div",
        { className: "tt-row tt-addrow", style: { width: LEFT + width } },
        h("div", { className: "tt-left tt-clickable", onClick: () => openForm() }, "+ 드래그해서 새 항목 추가"),
        h("div", { className: "tt-lane", style: { width }, onMouseDown: onAddLaneDown, title: "드래그해서 기간을 고르면 새 항목 입력창이 열립니다" }, ghost)
      )
    : null;

  const empty =
    dated.length === 0
      ? h(
          "div",
          { className: "tt-hint" },
          canCreate
            ? "아직 날짜가 입력된 항목이 없습니다. '+ 새 항목'을 누르거나 맨 아래 줄을 드래그해서 추가해 보세요."
            : "아직 날짜가 입력된 항목이 없습니다. Task의 Start Date / Due Date를 채우면 타임라인에 표시됩니다."
        )
      : null;

  return h(
    "div",
    { className: "tt-root" },
    toolbar,
    formBar,
    empty,
    h(
      "div",
      { className: "tt-scroll", ref: scrollRef },
      h("div", { className: "tt-canvas", style: { width: LEFT + width, height: HEADER + bodyHeight + (addRow ? ROW : 0) } }, header, h("div", { className: "tt-body" }, rowEls, addRow), overlay)
    ),
    h(
      "div",
      { className: "tt-legend" },
      ["to-do", "in-progress", "in-review", "done"].map((s) => h("span", { key: s }, h("i", { style: { background: STATUS[s].color } }), STATUS[s].label)),
      h("span", null, h("i", { className: "lg-overdue" }), "마감 지남"),
      h("span", null, h("i", { className: "lg-partial" }), "시작/마감 중 하나만 입력"),
      h("span", null, h("i", { className: "lg-today" }), "오늘")
    )
  );
}

export async function activate() {}
export async function deactivate() {}
export const panels = {
  timeline: { component: TimelinePanel },
};
