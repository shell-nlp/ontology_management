"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Database, KeyRound, Table2, Trash2 } from "lucide-react";
import { api } from "@/lib/shared/client/api-client";
import { planLinkSource } from "@/lib/ontology/link-source";
import { assertReadOnlySql } from "@/lib/shared/server/sql-guard";
import { dedupeSql, describeDedupeRule, matchesDedupeRule, orderCandidateColumns } from "@/lib/ontology/dedupe-sql";
import { sourceFieldsKey, sourceName, type EntitySource, type Property } from "@/lib/ontology/draft";
import type { DataViewField, DataViewSummary, PublicDataSource } from "@/lib/datasource/types";
import "../type-edit-dialog.css";

type SourceCardProps = {
  source: EntitySource;
  index: number;
  dataSources: PublicDataSource[];
  /** 主来源的主键列；补充来源按它对位连接。 */
  primaryKeyColumns: string[];
  propertyCount: number;
  /**
   * 这个对象类型已有的属性。**只在没有参考表字段清单时**用来推断候选排序列
   * （口径来源可能没留参考表，这时靠属性名里像日期的那几个）。
   */
  properties: { name: string; dataType: string }[];
  onChange: (patch: Partial<EntitySource>) => void;
  onPickDataSource: (dataSourceId: string) => void;
  onPickView: (view: string, schema: string) => void;
  onToggleKeyColumn?: (column: string) => void;
  onPickJoinKey?: (position: number, column: string) => void;
  onRemove?: () => void;
  onFields: (sourceId: string, key: string, fields: DataViewField[]) => void;
};

/**
 * 一份来源的编辑卡：选资源、选表；主来源再定主键与标题，补充来源按主键列逐个对位。
 * 每份来源自己读自己的结构，读到字段就报给上层——属性映射要用这份清单。
 */
/**
 * 口径的只读校验：**和后端同一个纯函数**（`assertReadOnlySql`），界面先给结论，别等保存才报错。
 * 空口径不算通过 —— 保存会被发布前校验挡下来，这里先说出来。
 */
function checkDerivedSql(sql: string): { ok: boolean; text: string } {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, text: "口径还是空的：写一段只读 SELECT（去重、聚合都写在这里）。" };
  try {
    assertReadOnlySql(trimmed, "取数口径");
    return { ok: true, text: "只读校验通过。" };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : "SQL 校验失败。" };
  }
}

export function SourceCard({ source, index, dataSources, primaryKeyColumns, propertyCount, properties, onChange, onPickDataSource, onPickView, onToggleKeyColumn, onPickJoinKey, onRemove, onFields }: SourceCardProps) {
  const primary = index === 0;
  /** 取数口径：只有主来源支持（补充来源仍是表 / 视图，后端校验里也是这么要求的）。 */
  const derived = primary && source.kind === "DERIVED";
  const sqlCheck = derived ? checkDerivedSql(source.sql) : null;
  // 拆成基本值：下面的请求只跟这些值走，父组件重渲染不会顺手把请求重发一遍。
  const dataSourceId = source.dataSourceId;
  const view = source.view;
  const schema = source.schema;
  const sourceId = source.id;
  // 读到的结构跟着「表身份」走：换资源或换表，旧的那份自动不算数，不用额外清空。
  const [viewsState, setViewsState] = useState<{ dataSourceId: string; rows: DataViewSummary[] }>({ dataSourceId: "", rows: [] });
  const [fieldsState, setFieldsState] = useState<{ key: string; rows: DataViewField[] }>({ key: "", rows: [] });
  const [error, setError] = useState("");
  const viewListId = useId();
  const fieldsKey = sourceFieldsKey({ dataSourceId, view });
  const views = viewsState.dataSourceId === dataSourceId ? viewsState.rows : [];
  const fields = fieldsState.key === fieldsKey ? fieldsState.rows : [];
  // 回调存进 ref：请求重发时不会因为回调换了个身份而多跑一轮。
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // 选定资源后拉它的结构清单，给「表 / 视图」那个输入框做候选。
  useEffect(() => {
    if (!dataSourceId) return;
    let cancelled = false;
    void api<{ views: DataViewSummary[] }>(`/api/data-sources/${dataSourceId}/views?limit=5000`)
      .then((data) => {
        if (cancelled) return;
        setViewsState({ dataSourceId, rows: data.views });
        // 表名可能是手打的：结构清单到了之后把 schema 补回去，别存下一份缺 schema 的绑定。
        const match = data.views.find((item) => item.name === view);
        if (match?.schema && match.schema !== schema) onChangeRef.current({ schema: match.schema });
      })
      .catch(() => { if (!cancelled) setViewsState({ dataSourceId, rows: [] }); });
    return () => { cancelled = true; };
  }, [dataSourceId, view, schema]);

  // 选定表之后取字段：主键、连接键和属性映射都从这份字段清单里选。
  useEffect(() => {
    // 口径档也要拉字段：它不是用来取数的，是用来**挑"取哪一行"的依据列**（生成口径）。
    if (!dataSourceId || !view) return;
    const key = fieldsKey;
    const query = schema ? `limit=1&schema=${encodeURIComponent(schema)}` : "limit=1";
    let cancelled = false;
    void api<{ fields: DataViewField[] }>(`/api/data-sources/${dataSourceId}/views/${encodeURIComponent(view)}?${query}`)
      .then((data) => { if (!cancelled) { setFieldsState({ key, rows: data.fields }); setError(""); onFields(sourceId, key, data.fields); } })
      .catch((reason) => { if (!cancelled) { setFieldsState({ key, rows: [] }); onFields(sourceId, key, []); setError(reason instanceof Error ? reason.message : "读取字段失败。"); } });
    return () => { cancelled = true; };
  }, [dataSourceId, view, schema, sourceId, fieldsKey, onFields]);
  const joinKeys = primaryKeyColumns.map((_, position) => source.primaryKey[position] ?? "");

  /*
   * 「按规则生成口径」：分组键 + 取值依据 + 取最新/最早，三样一选就生成一段**确定的** SQL。
   * 默认分组键取对象类型已配的主键列（没有就用参考表自己的主键列），取值依据取第一个日期类候选列。
   */
  /** 分组键：`null` = 还没动过，用默认值（对象类型已配的主键列）。**复合主键就是多列**。 */
  // 有规则就按规则回填（改一列重新生成，不用从零再选一遍）。
  const [dedupeKeys, setDedupeKeys] = useState<string[] | null>(() => (source.rule?.keyColumns ?? []).filter(Boolean).length ? (source.rule?.keyColumns ?? []).filter(Boolean) : null);
  const [dedupeOrder, setDedupeOrder] = useState(() => source.rule?.orderColumn ?? "");
  const [dedupeDirection, setDedupeDirection] = useState<"DESC" | "ASC">(() => (source.rule?.direction === "ASC" ? "ASC" : "DESC"));
  /*
   * 候选排序列优先用**参考表的真实列**；参考表还没选（口径来源可能没留表名）时退回**属性名**推断 ——
   * 属性名就是列名（映射按同名），够生成一段能跑的口径，界面上会标出这是推断来的。
   */
  /** 生成口径必须有**参考表**（真实列清单）：没留参考表时只能给指引，不能凭属性名猜 FROM 子句。 */
  const referenceTable = view.trim();
  const orderColumns = derived && referenceTable ? orderCandidateColumns(fields) : [];
  const propertyDateHints = derived && !referenceTable ? orderCandidateColumns(properties).map((field) => field.name) : [];
  const selectedKeys = dedupeKeys ?? (source.primaryKey.filter(Boolean).length
    ? source.primaryKey.filter(Boolean)
    : fields.filter((field) => field.primaryKey).map((field) => field.name));
  const toggleKey = (name: string) => setDedupeKeys(selectedKeys.includes(name) ? selectedKeys.filter((item) => item !== name) : [...selectedKeys, name]);
  const canBuildSql = Boolean(referenceTable) && orderColumns.length > 0 && selectedKeys.length > 0;
  const orderColumn = dedupeOrder || orderColumns[0]?.name || "";
  const dataSourceKind = dataSources.find((item) => item.id === dataSourceId)?.kind ?? "POSTGRES";
  /** 存下来的生成参数（手写 SQL 就是 null）与它的人话回显。 */
  const savedRule = derived ? source.rule ?? null : null;
  const ruleSentence = savedRule ? describeDedupeRule(savedRule) : "";
  /**
   * SQL 和规则**对不上**（存了规则但 SQL 被手改过）。要说出来 —— 否则界面写着"取最新一天"，跑的却是另一段 SQL。
   * 没有参考表就没法按方言重新生成，这时不判（不冤枉手改）。
   */
  const ruleMismatch = Boolean(savedRule && referenceTable && ruleSentence) && !matchesDedupeRule({ kind: dataSourceKind, schema, view, rule: savedRule!, sql: source.sql });
  const applyDedupe = () => {
    try {
      const rule = { keyColumns: selectedKeys, orderColumn, direction: dedupeDirection };
      const sql = dedupeSql({ kind: dataSourceKind, schema, view, rule });
      // 口径输出的就是分组键那几列，对象主键顺手也对上 —— 省一次手工同步。
      // `rule` 一起存：界面能回显人话、能按它重新生成，平台也能校验"SQL 与规则还是不是一回事"。
      onChange({ sql, primaryKey: selectedKeys, rule });
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成口径失败。");
    }
  };

  return (
    <div className="ted-source-card" data-primary={primary}>
      <div className="ted-source-rail" aria-hidden="true">
        <span className="ted-source-dot" />
        <em>{primary ? "主" : index}</em>
      </div>
      <div className="ted-source-body">
        <div className="ted-source-head">
          <b>{primary ? "主来源" : `补充来源 ${index}`}</b>
          <span>{sourceName(source)}{propertyCount ? ` · ${propertyCount} 条属性` : " · 暂无属性"}</span>
          {onRemove && <button type="button" className="ted-icon-button danger" onClick={onRemove} title="移除这份来源"><Trash2 size={13} /></button>}
        </div>
        {primary && (
          <div className="view-switcher ted-source-mode">
            <button type="button" className={derived ? "" : "active"} aria-pressed={!derived} onClick={() => onChange({ kind: "PHYSICAL" })}>
              <Table2 size={12} />表 / 视图
            </button>
            {/* 切到口径**保留**已选的表：它是这段口径的「参考表」—— 生成规则要按它挑列，也能一眼看出口径从哪来。 */}
            <button type="button" className={derived ? "active" : ""} aria-pressed={derived} onClick={() => onChange({ kind: "DERIVED" })}>
              <Database size={12} />取数口径
            </button>
          </div>
        )}
        <div className="ted-grid-2">
          <label className="ted-field">
            <span>数据资源</span>
            <select className="ted-select" value={source.dataSourceId} onChange={(event) => onPickDataSource(event.target.value)}>
              <option value="">不绑定（只做建模）</option>
              {source.dataSourceId && !dataSources.some((item) => item.id === source.dataSourceId) && <option value={source.dataSourceId}>这个数据资源已不在清单里</option>}
              {dataSources.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kindLabel}</option>)}
            </select>
          </label>
          {!derived && <label className="ted-field">
            <span><Table2 size={12} />表 / 视图</span>
            <input
              className="ted-input"
              list={viewListId}
              value={source.view}
              disabled={!source.dataSourceId}
              onChange={(event) => onPickView(event.target.value, views.find((item) => item.name === event.target.value)?.schema ?? source.schema)}
              placeholder={source.dataSourceId ? "输入或从下拉里选一个表名" : "先选数据资源"}
            />
            <datalist id={viewListId}>{views.map((item) => <option key={`${item.schema}.${item.name}`} value={item.name}>{item.comment || `${item.columnCount} 个字段`}</option>)}</datalist>
          </label>}
        </div>
        {!derived && source.dataSourceId && source.view && <label className="ted-field">
          <span><Database size={12} />读取路径</span>
          <select className="ted-select" value={source.readMode} onChange={(event) => onChange({ readMode: event.target.value === "ODS" ? "ODS" : event.target.value === "DIRECT" ? "DIRECT" : "AUTO" })}>
            <option value="AUTO">ODS 优先，缺失时回退源库</option>
            <option value="DIRECT">只读源业务库</option>
            <option value="ODS">必须读 ODS（不可用时拒绝）</option>
          </select>
          <small>ODS 在「数据资源 → 表详情 → ODS 镜像」里配置。对象实例始终在查询时投影，不按版本复制。</small>
        </label>}
        {derived && (
          <>
            {ruleSentence && (
              <p className={ruleMismatch ? "ted-source-error" : "ted-source-note"}>
                {ruleMismatch && <AlertTriangle size={13} />}
                当前规则：{ruleSentence}。{ruleMismatch && "下面的 SQL 和这条规则对不上（手改过）：按规则重新生成一次，或者把规则清掉。"}
                <button type="button" className="action compact" onClick={() => onChange({ rule: null })}>清掉规则</button>
              </p>
            )}
            <div className="ted-dedupe">
              <div className="ted-dedupe-head">
                <b>按规则生成</b>
                <span>不会写 SQL 就用这里：选分组键 + 取值依据，生成一段「确定的」去重口径</span>
              </div>
              {!referenceTable ? (
                <p className="ted-source-note">
                  这段口径还没留「参考表」：先切到「表 / 视图」选一次表再切回来，这里就能按真实列清单生成口径 ——
                  否则 FROM 子句写不出来，只能在下面手写 SQL。
                  {propertyDateHints.length > 0 && <>（你的属性里这几列名字像日期，可以当「取哪一行」的依据：{propertyDateHints.join("、")}）</>}
                </p>
              ) : orderColumns.length === 0 ? (
                <p className="ted-source-error">
                  <AlertTriangle size={13} />
                  参考表里没有日期 / 时间列，用不了「取最新一行」的规则。两条路：① 把主键换成真正唯一的键（行 uuid / 业务单号）——
                  那根本不需要去重，这个对象类型的一行就是一行；② 按业务条件筛一行（例如「状态 = 有效」），条件得你自己写在下面的 SQL 里。
                </p>
              ) : (
                <>
                  <div className="ted-field ted-dedupe-keys">
                    <span>分组键（一个对象一行，可多选 = 复合主键）</span>
                    {fields.length ? (
                      <div className="ted-source-picker">
                        {fields.map((field) => (
                          <label key={field.name} className={selectedKeys.includes(field.name) ? "ted-chip active" : "ted-chip"}>
                            <input type="checkbox" checked={selectedKeys.includes(field.name)} onChange={() => toggleKey(field.name)} />
                            {field.primaryKey && <KeyRound size={11} />}
                            {field.name}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <input
                        className="ted-input"
                        value={selectedKeys.join(", ")}
                        onChange={(event) => setDedupeKeys(event.target.value.split(/[,，\s]+/).map((part) => part.trim()).filter(Boolean))}
                        placeholder="USER_ID"
                      />
                    )}
                    <small>复合主键就勾多列：口径按「这一组列的值都一样」判断是不是同一个对象。</small>
                  </div>
                  <div className="ted-dedupe-row">
                  <label className="ted-field">
                    <span>取值依据</span>
                    <select className="ted-select" value={orderColumn} onChange={(event) => setDedupeOrder(event.target.value)}>
                      {orderColumns.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
                    </select>
                  </label>
                  <label className="ted-field">
                    <span>取哪一行</span>
                    <select className="ted-select" value={dedupeDirection} onChange={(event) => setDedupeDirection(event.target.value as "DESC" | "ASC")}>
                      <option value="DESC">最新一行</option>
                      <option value="ASC">最早一行</option>
                    </select>
                  </label>
                  <button type="button" className="ted-add-button" disabled={!canBuildSql} onClick={applyDedupe}><Check size={13} />生成并填入</button>
                  </div>
                </>
              )}
            </div>
            <label className="ted-field">
              <span><Database size={12} />取数口径（只读 SELECT）</span>
              <textarea
                className="ted-input ted-sql"
                rows={5}
                value={source.sql}
                onChange={(event) => onChange({ sql: event.target.value })}
                placeholder={"SELECT user_id, MAX(user_name) AS user_name\n  FROM GISTOOLS.TB_XXX\n GROUP BY user_id"}
              />
              <small>对象读的是这段 SQL 的结果，不是原始行 —— 去重、聚合、拼装都写在这里。执行时会被包成子查询，所以别用分号结尾。</small>
            </label>
            {sqlCheck && (sqlCheck.ok
              ? <p className="ted-source-sql-ok"><Check size={13} />{sqlCheck.text}</p>
              : <p className="ted-source-error"><AlertTriangle size={13} />{sqlCheck.text}</p>)}
            <div className="ted-grid-2">
              <label className="ted-field">
                <span><KeyRound size={12} />主键列（对象身份）</span>
                <input
                  className="ted-input"
                  value={source.primaryKey.join(", ")}
                  onChange={(event) => onChange({ primaryKey: event.target.value.split(/[,，\s]+/).map((part) => part.trim()).filter(Boolean) })}
                  placeholder="user_id"
                />
                <small>口径必须输出这几列；多个用逗号隔开，顺序就是对象身份的顺序。</small>
              </label>
              <label className="ted-field">
                <span>显示名（可选）</span>
                <input className="ted-input" value={source.titleField} onChange={(event) => onChange({ titleField: event.target.value })} placeholder="user_name" />
                <small>对象在列表和图谱上的标题取这一列；留空就按上面的「显示属性」。</small>
              </label>
            </div>
          </>
        )}
        {error && <p className="ted-source-error"><AlertTriangle size={13} />{error}</p>}
        {primary ? (
          !derived && fields.length > 0 && <>
            <label className="ted-field">
              <span>对象的显示名</span>
              <select className="ted-select" value={source.titleField} onChange={(event) => onChange({ titleField: event.target.value })}>
                <option value="">跟随「显示属性」</option>
                {source.titleField && !fields.some((field) => field.name === source.titleField) && <option value={source.titleField}>{source.titleField} · 当前映射</option>}
                {fields.map((field) => <option key={field.name} value={field.name}>{field.name}{field.comment ? ` · ${field.comment}` : ""}</option>)}
              </select>
              <small>对象在列表和图谱上的标题取这一列；留空就按上面的「显示属性」。</small>
            </label>
            <div className="ted-field">
              <span>主键字段（对象身份）</span>
              <div className="ted-source-picker">
                {fields.map((field) => <label key={field.name} className={source.primaryKey.includes(field.name) ? "ted-chip active" : "ted-chip"}>
                  <input type="checkbox" checked={source.primaryKey.includes(field.name)} onChange={() => onToggleKeyColumn?.(field.name)} />
                  {field.primaryKey && <KeyRound size={11} />}
                  {field.name}
                </label>)}
                {/* 表换过之后，老的键不在字段清单里了：也显示出来，点一下就能去掉。 */}
                {source.primaryKey.filter((column) => column && !fields.some((field) => field.name === column)).map((column) => <label key={`stored-${column}`} className="ted-chip active stored" title="当前表里没有这一列，可能表已经换过">
                  <input type="checkbox" checked onChange={() => onToggleKeyColumn?.(column)} />
                  {column}
                </label>)}
              </div>
              <small>一个对象就是这张表里的一行，靠这几列认身份；表自己有主键的话用钥匙标出来了。</small>
            </div>
          </>
        ) : (
          <div className="ted-field">
            <span><KeyRound size={12} />连接键</span>
            {primaryKeyColumns.length ? (
              <div className="ted-key-map">
                {primaryKeyColumns.map((column, position) => (
                  <div className="ted-key-row" key={`${column}-${position}`}>
                    <code>{column}</code>
                    <ArrowGlyph />
                    <select className="ted-select" value={joinKeys[position]} disabled={!fields.length && !joinKeys[position]} onChange={(event) => onPickJoinKey?.(position, event.target.value)}>
                      <option value="">选择本表的列</option>
                      {joinKeys[position] && !fields.some((field) => field.name === joinKeys[position]) && <option value={joinKeys[position]}>{joinKeys[position]} · 当前映射</option>}
                      {fields.map((field) => <option key={field.name} value={field.name}>{field.name}{field.primaryKey ? " · 主键" : ""}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            ) : <p className="ted-props-empty">先在主来源里指定主键列，这里才知道要和哪几列对齐。</p>}
            <small>这张表里对应对象主键的列；按顺序一一对齐，就是两份来源的连接条件。</small>
          </div>
        )}
      </div>
    </div>
  );
}

/** 方向和对齐都用这个小箭头：比文字省地方，也一眼能看出从哪指到哪。 */
export function ArrowGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h13" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}
