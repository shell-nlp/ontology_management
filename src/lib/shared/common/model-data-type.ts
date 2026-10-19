/**
 * 本体属性与对象运行时的统一数据类型。
 *
 * 这是客户端、本体定义、图适配器和对象索引共同使用的最小契约；各层不要再各写一份
 * 字符串联合类型，否则新增类型时很容易遗漏某个分支。
 */
export const MODEL_DATA_TYPES = ["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"] as const;

export type DataType = (typeof MODEL_DATA_TYPES)[number];
