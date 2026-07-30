# 实体与关系属性编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员在实体和关系管理页选中一条实例后，在固定右侧详情面板编辑已发布本体允许的属性并安全保存到 Neo4j。

**Architecture:** 把属性值解析、类型校验和 Cypher 更新语句的构造抽取为无副作用的服务端模块。两个薄 Next.js `PATCH` 路由负责认证、加载目标和已发布本体，再调用该模块及 `neo4j-driver`。前端新增可复用的属性编辑器，实体与关系管理器只负责列表选择、加载、保存和同步刷新。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Vitest、Testing Library、Zod、neo4j-driver、React Flow。

## Global Constraints

- 仅管理员可保存属性；查看者没有保存入口且更新请求必须返回 403。
- 编辑不得修改实体 Label、关系 Type、关系端点或 `elementId`。
- 只允许已发布本体定义的字段；数据类型为 TEXT、INTEGER、DECIMAL、BOOLEAN、DATE、DATETIME、TEXT_ARRAY、JSON。
- 实体和关系的保存都使用显式按钮；失败时保留前端编辑值。
- 桌面端固定双栏，窄屏详情抽屉；不新增删除或类型迁移功能。
- 所有用户可见文档存放于 `docs/superpowers/`，不恢复 `CONTEXT.md` 或 `docs/adr/`。

---

### Task 1: 建立测试运行器和属性更新验证器

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/lib/instance-property-editor.ts`
- Create: `src/lib/instance-property-editor.test.ts`

**Interfaces:**
- Produces `parseEditableProperties(definitions, rawValues): Record<string, unknown>`。
- Produces `buildNodePropertyUpdate(label, elementId, properties): { cypher: string; parameters: Record<string, unknown> }`。
- Produces `buildRelationshipPropertyUpdate(type, elementId, properties): { cypher: string; parameters: Record<string, unknown> }`。
- Later routes consume the parser and update builders; the client never receives Cypher text.

- [ ] **Step 1: 添加失败测试与 Vitest 命令**

在 `package.json` 添加 `test` 与 `test:watch`，安装 `vitest`。创建以下测试：

```ts
import { describe, expect, it } from "vitest";
import { parseEditableProperties } from "./instance-property-editor";

const properties = [
  { name: "名称", dataType: "TEXT", required: true },
  { name: "数量", dataType: "INTEGER", required: false },
  { name: "启用", dataType: "BOOLEAN", required: false },
] as const;

describe("parseEditableProperties", () => {
  it("coerces valid text, integer, and boolean values", () => {
    expect(parseEditableProperties(properties, { 名称: "客户A", 数量: "12", 启用: "true" }))
      .toEqual({ 名称: "客户A", 数量: 12, 启用: true });
  });

  it("rejects an undefined property", () => {
    expect(() => parseEditableProperties(properties, { 名称: "客户A", 等级: "A" }))
      .toThrow("属性 等级 未在已发布类型中定义。");
  });

  it("rejects a missing required property", () => {
    expect(() => parseEditableProperties(properties, { 名称: "" }))
      .toThrow("缺少必填属性：名称。");
  });
});
```

- [ ] **Step 2: 运行测试，确认因模块不存在而失败**

Run: `pnpm test src/lib/instance-property-editor.test.ts`

Expected: FAIL，错误说明无法解析 `./instance-property-editor`。

- [ ] **Step 3: 实现最小属性解析与更新语句构造**

创建 `src/lib/instance-property-editor.ts`。逐项处理类型：TEXT 保持字符串；INTEGER 使用 `Number()` 并要求 `Number.isInteger`；DECIMAL 使用 `Number()` 并要求有限值；BOOLEAN 仅接受 `true`、`false`、`"true"`、`"false"`；DATE、DATETIME 接受非空 ISO 字符串；TEXT_ARRAY 接受字符串数组或 JSON 数组字符串；JSON 接受对象或 JSON 对象字符串。拒绝未定义字段、缺失必填字段和不符合类型的值。

更新构造函数必须使用 `quoteCypherIdentifier` 包裹 Label、关系 Type 和属性名，并使用参数 `$elementId`、`$properties`：

```ts
const cypher = `MATCH (n:${quoteCypherIdentifier(label)})
WHERE elementId(n) = $elementId
SET n += $properties
RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties`;
```

关系查询使用 `MATCH ()-[r:${quoteCypherIdentifier(type)}]->()`，返回 `id`、`type`、`sourceId`、`targetId` 和 `properties`。

- [ ] **Step 4: 运行单元测试并添加更新语句断言**

扩展测试：断言节点构造函数包含 `MATCH (n:\`客户\`)` 与 `elementId(n) = $elementId`；关系构造函数包含 `MATCH ()-[r:\`负责\`]->()`；参数中不含 Label、Type 或 Cypher 片段。运行：`pnpm test src/lib/instance-property-editor.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交测试基础与验证器**

```powershell
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/instance-property-editor.ts src/lib/instance-property-editor.test.ts
git commit -m "test: 覆盖实例属性更新验证"
```

### Task 2: 新增受本体约束的实例属性更新 API

**Files:**
- Modify: `src/app/api/instances/entities/route.ts`
- Modify: `src/app/api/instances/relationships/route.ts`
- Create: `src/lib/instance-update-service.ts`
- Create: `src/app/api/instances/entities/[elementId]/route.ts`
- Create: `src/app/api/instances/relationships/[elementId]/route.ts`
- Create: `src/app/api/instances/instance-update-route.test.ts`

**Interfaces:**
- Consumes `parseEditableProperties`、`buildNodePropertyUpdate`、`buildRelationshipPropertyUpdate`。
- Produces `PATCH /api/instances/entities/:elementId` 和 `PATCH /api/instances/relationships/:elementId`。
- 成功响应分别返回当前实体或关系记录；失败响应统一为 `{ error: string }`。

- [ ] **Step 1: 编写路由行为失败测试**

将路由的依赖抽成参数可注入的 `updateEntityProperties` 与 `updateRelationshipProperties` 服务函数，避免为测试启动真实 Next 服务器。测试使用内存替身验证：

```ts
it("does not call Neo4j when the actor is a viewer", async () => {
  const runCypher = vi.fn();
  await expect(updateEntityProperties({ role: "VIEWER" }, request, deps({ runCypher })))
    .rejects.toThrow("UNAUTHORIZED");
  expect(runCypher).not.toHaveBeenCalled();
});

it("updates only validated properties for the published entity type", async () => {
  const runCypher = vi.fn().mockResolvedValue({ records: [{ id: "4:node", labels: ["客户"], properties: { 名称: "客户B" } }] });
  const result = await updateEntityProperties({ role: "ADMIN" }, validEntityRequest, deps({ runCypher }));
  expect(runCypher).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("SET n += $properties"), { elementId: "4:node", properties: { 名称: "客户B" } });
  expect(result.properties.名称).toBe("客户B");
});
```

- [ ] **Step 2: 运行测试，确认更新服务尚不存在**

Run: `pnpm test src/app/api/instances/instance-update-route.test.ts`

Expected: FAIL，错误说明更新服务或导出尚未定义。

- [ ] **Step 3: 实现更新服务和 PATCH 路由**

在 `src/lib/instance-update-service.ts` 创建两个服务函数。它们按顺序：验证管理员角色、读取目标、读取已发布本体、读取目标实例当前类型、定位该类型的属性定义、调用属性解析器、构造参数化 Cypher、执行并检查首条记录存在。

实体读取使用：

```cypher
MATCH (n) WHERE elementId(n) = $elementId
RETURN labels(n) AS labels
```

关系读取使用：

```cypher
MATCH ()-[r]->() WHERE elementId(r) = $elementId
RETURN type(r) AS type
```

两个 `route.ts` 从路径参数读取唯一的 `elementId`，只解析 `{ properties }`、获取当前用户、调用服务，并将 `UNAUTHORIZED` 转换为 403、缺失目标或实例转换为 404、校验错误转换为 422、Neo4j 执行错误转换为 400。

- [ ] **Step 4: 运行路由服务测试并验证未授权、校验失败、成功更新**

Run: `pnpm test src/app/api/instances/instance-update-route.test.ts`

Expected: PASS，`runCypher` 仅在管理员且值校验通过时调用。

- [ ] **Step 5: 提交 API 更新功能**

```powershell
git add src/lib/instance-update-service.ts src/app/api/instances src/app/api/instances/instance-update-route.test.ts
git commit -m "feat: 支持受本体约束的实例属性更新"
```

### Task 3: 接入固定分栏属性编辑器

**Files:**
- Create: `src/components/instance-property-editor.tsx`
- Create: `src/components/instance-property-editor.test.tsx`
- Modify: `src/components/functional-workbench.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes实体或关系的 `id`、类型元数据、当前 `properties`、`readonly` 与 `onSave(properties)`。
- Produces `InstancePropertyEditor`，仅在 `readonly === false` 时显示保存按钮。
- `EntityManager` 与 `RelationshipManager` 都维护 `selectedId`，并把成功响应合并回本地列表。

- [ ] **Step 1: 编写组件失败测试**

使用 Testing Library 添加测试：

```tsx
it("selects and saves edited values only after the save button is pressed", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<InstancePropertyEditor properties={[{ name: "名称", dataType: "TEXT", required: true }]} value={{ 名称: "客户A" }} onSave={onSave} />);
  await user.clear(screen.getByLabelText("名称"));
  await user.type(screen.getByLabelText("名称"), "客户B");
  expect(onSave).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "保存属性" }));
  expect(onSave).toHaveBeenCalledWith({ 名称: "客户B" });
});

it("does not render a save button for a viewer", () => {
  render(<InstancePropertyEditor readonly properties={[]} value={{}} onSave={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "保存属性" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行组件测试，确认组件不存在而失败**

Run: `pnpm test src/components/instance-property-editor.test.tsx`

Expected: FAIL，错误说明模块不存在。

- [ ] **Step 3: 实现可复用编辑器与数据类型控件**

实现 `InstancePropertyEditor`：TEXT、DATE、DATETIME 生成对应输入框；INTEGER、DECIMAL 生成数字输入；BOOLEAN 生成复选框；TEXT_ARRAY 和 JSON 生成文本域。组件接收初始化值，在内部维护草稿值；点击保存时只调用 `onSave`，不自行请求 API。必要字段以 `required` 标记，服务端拒绝错误通过 `saveError` 显示在表单顶部。

在实体、关系管理器中把当前列表从单一列改为 `grid-template-columns: minmax(360px, 1fr) minmax(360px, .9fr)`。左侧每行改为按钮，点击后设置 `selectedId`；右侧显示 `elementId`、类型或端点的只读信息和编辑器。保存回调分别调用新的 PATCH API；成功后替换 `rows` 中同 ID 项，失败时把错误传给编辑器而不清空草稿。

- [ ] **Step 4: 运行组件测试、类型检查和静态检查**

Run:

```powershell
pnpm test src/components/instance-property-editor.test.tsx
pnpm typecheck
pnpm lint
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交前端编辑工作流**

```powershell
git add src/components/instance-property-editor.tsx src/components/instance-property-editor.test.tsx src/components/functional-workbench.tsx src/app/globals.css
git commit -m "feat: 在实例列表中编辑属性"
```

### Task 4: 完整验证和响应式检查

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-instance-property-editing-design.md`（仅在实现与规格不一致时修正）

**Interfaces:**
- Consumes前三个任务的测试与构建命令。
- Produces可复现的验证记录和干净 Git 工作区。

- [ ] **Step 1: 运行全量自动验证**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: 所有命令退出码为 0。

- [ ] **Step 2: 运行管理员手工验收**

在浏览器登录管理员账号，选择包含已发布本体的 Neo4j 目标：在实体页点击一行，修改一个已定义属性并保存；刷新后确认值仍存在。重复关系页流程。分别尝试输入未定义字段、清空必填字段和以查看者登录保存，确认显示规格定义的拒绝错误。

- [ ] **Step 3: 检查窄屏详情抽屉**

在浏览器 390x844 视口选择实体和关系，确认详情覆盖列表但保存、取消和错误文本均完整可操作；关闭详情后列表保持当前滚动位置。

- [ ] **Step 4: 提交必要的规格修正并确认工作区状态**

Run:

```powershell
git status --short
git log -4 --oneline
```

Expected: 没有未提交的实现文件；提交历史包含三项功能提交和最终验证所需的规格修正提交。
