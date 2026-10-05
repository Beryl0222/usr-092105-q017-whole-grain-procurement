import { AGGREGATE_TYPES, EVENT_CATALOG, EVENT_TYPES } from "./catalog.js";

const envelopeRequired = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "payload",
];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 返回可以直接展示给接入方的中文错误。校验信封形状与事件目录，不解释业务规则。 */
export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }

  for (const name of envelopeRequired) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length) return errors;

  if (typeof record.event_id !== "string" || record.event_id.length < 8) {
    errors.push("event_id 必须是不少于 8 个字符的字符串");
  }
  if (!EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length < 1) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是正整数");
  }
  if (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是带时区的 ISO 日期时间");
  }
  if (typeof record.summary !== "string" || record.summary.trim().length < 2) {
    errors.push("summary 必须是至少 2 个字符的中文摘要");
  }
  if (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    errors.push("payload 必须是对象");
  }

  const spec = EVENT_CATALOG[record.event_type];
  if (spec) {
    if (record.aggregate_type !== spec.aggregate) {
      errors.push(`${record.event_type} 只能挂在聚合 ${spec.aggregate} 上，收到的是 ${record.aggregate_type}`);
    }
    if (record.payload && typeof record.payload === "object") {
      for (const field of spec.required) {
        if (!(field in record.payload)) errors.push(`payload 缺少字段：${field}`);
      }
    }
  }

  return errors;
}

/** 校验一批事件：除单条形状外，还检查同一聚合内 version 连续、event_id 不重复、时间合法。 */
export function validateStream(events) {
  const errors = [];
  const seenIds = new Set();
  const versions = new Map();

  events.forEach((event, index) => {
    const where = `第 ${index + 1} 条（${event?.event_id ?? "无 event_id"}）`;
    for (const message of validateEvent(event)) errors.push(`${where}：${message}`);

    if (!event || typeof event !== "object") return;
    if (seenIds.has(event.event_id)) errors.push(`${where}：event_id 重复：${event.event_id}`);
    seenIds.add(event.event_id);

    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    const last = versions.get(key);
    if (last !== undefined) {
      if (event.version !== last.version + 1) {
        errors.push(`${where}：聚合 ${key} 版本不连续，应为 ${last.version + 1}，收到 ${event.version}`);
      }
      if (new Date(event.occurred_at) < new Date(last.at)) {
        errors.push(`${where}：聚合 ${key} 的 occurred_at 早于上一事件（${last.at}）`);
      }
    } else if (event.version !== 1) {
      errors.push(`${where}：聚合 ${key} 首个事件 version 必须为 1`);
    }
    versions.set(key, { version: event.version, at: event.occurred_at });
  });

  return errors;
}
