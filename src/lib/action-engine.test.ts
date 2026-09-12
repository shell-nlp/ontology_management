import { describe, expect, it } from "vitest";
import { runAction, validateActionDefinition, visibleActions, type ActionGraph } from "@/lib/action-engine";
import { ontologyDefinitionSchema } from "@/lib/ontology";

const passengerTypeId = "11111111-1111-4111-8111-111111111111";
const ticketTypeId = "22222222-2222-4222-8222-222222222222";
const trainTypeId = "33333333-3333-4333-8333-333333333333";
const ownsTypeId = "44444444-4444-4444-8444-444444444444";
const ridesTypeId = "55555555-5555-4555-8555-555555555555";
const buyActionId = "66666666-6666-4666-8666-666666666666";
const studentRuleId = "77777777-7777-4777-8777-777777777777";
const passengerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trainId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** 一个最小可跑的 12306 场景：乘客买一张票，票属于乘客、乘坐车次。 */
function definition(options: { studentQualified: boolean; ruleEnabled?: boolean; effect?: "HIDE" | "BLOCK" | "WARN"; ruleConditions?: unknown[] }) {
  return ontologyDefinitionSchema.parse({
    entityTypes: [
      { id: passengerTypeId, name: "乘客", description: "", displayProperty: "姓名", properties: [
        { name: "姓名", dataType: "TEXT", required: true, unique: true, indexed: false },
        { name: "学生资质", dataType: "BOOLEAN", required: false, unique: false, indexed: false },
      ] },
      { id: ticketTypeId, name: "车票", description: "", displayProperty: "票号", properties: [
        { name: "票号", dataType: "TEXT", required: true, unique: true, indexed: false },
        { name: "票种", dataType: "TEXT", required: true, unique: false, indexed: false },
      ] },
      { id: trainTypeId, name: "车次", description: "", displayProperty: "车次号", properties: [
        { name: "车次号", dataType: "TEXT", required: true, unique: true, indexed: false },
      ] },
    ],
    relationshipTypes: [
      { id: ownsTypeId, name: "归属于", sourceEntityTypeId: ticketTypeId, targetEntityTypeId: passengerTypeId, properties: [] },
      { id: ridesTypeId, name: "乘坐", sourceEntityTypeId: ticketTypeId, targetEntityTypeId: trainTypeId, properties: [] },
    ],
    actionTypes: [
      {
        id: buyActionId,
        name: "购票",
        code: "buyTicket",
        description: "",
        params: [
          { code: "passenger", name: "乘客", kind: "ENTITY_REF", entityTypeId: passengerTypeId, dataType: "TEXT", required: true },
          { code: "train", name: "车次", kind: "ENTITY_REF", entityTypeId: trainTypeId, dataType: "TEXT", required: true },
          { code: "ticketType", name: "票种", kind: "VALUE", entityTypeId: "", dataType: "TEXT", required: true },
        ],
        edits: [
          { op: "CREATE_ENTITY", alias: "ticket", entityTypeId: ticketTypeId, relationshipTypeId: "", entityRef: { kind: "PARAM", code: "" }, sourceRef: { kind: "PARAM", code: "" }, targetRef: { kind: "PARAM", code: "" }, assignments: [
            { property: "票号", value: { kind: "CONST", code: "", value: "TK-0001" } },
            { property: "票种", value: { kind: "PARAM", code: "ticketType", value: "" } },
          ] },
          { op: "CREATE_RELATIONSHIP", alias: "", entityTypeId: "", relationshipTypeId: ownsTypeId, entityRef: { kind: "PARAM", code: "" }, sourceRef: { kind: "EDIT", code: "ticket" }, targetRef: { kind: "PARAM", code: "passenger" }, assignments: [] },
          { op: "CREATE_RELATIONSHIP", alias: "", entityTypeId: "", relationshipTypeId: ridesTypeId, entityRef: { kind: "PARAM", code: "" }, sourceRef: { kind: "EDIT", code: "ticket" }, targetRef: { kind: "PARAM", code: "train" }, assignments: [] },
        ],
      },
    ],
    rules: [
      {
        id: studentRuleId,
        name: "学生票须持学生资质",
        effect: options.effect ?? "BLOCK",
        priority: 1,
        enabled: options.ruleEnabled ?? true,
        actionId: buyActionId,
        conditions: options.ruleConditions ?? [
          { subject: { kind: "EDIT", code: "ticket", relationshipTypeId: "", direction: "OUT" }, property: "票种", operator: "EQUALS", compareValue: "学生票" },
          { subject: { kind: "PARAM", code: "passenger", relationshipTypeId: "", direction: "OUT" }, property: "学生资质", operator: "IS_FALSY", compareValue: "" },
        ],
        message: "拒绝出票：乘客不具备学生资质，学生票仅对完成资质认证的乘客发售。",
      },
    ],
  });
}

function graph(): ActionGraph {
  return {
    nodes: [
      { id: passengerId, labels: ["乘客"], properties: { 姓名: "张三", 学生资质: false } },
      { id: trainId, labels: ["车次"], properties: { 车次号: "G1" } },
    ],
    relationships: [],
  };
}

const inputs = [
  { code: "passenger", entityId: passengerId },
  { code: "train", entityId: trainId },
];

/** 给动作配上作用的类（乘客），模拟 Palantir 里"动作定义在某个类上"。 */
function withScope(source: ReturnType<typeof definition>) {
  const next = structuredClone(source);
  next.actionTypes[0].scopeEntityTypeId = passengerTypeId;
  return next;
}

describe("动作引擎", () => {
  it("闸门规则命中时拦截，且不改动原图", () => {
    const before = graph();
    const outcome = runAction(definition({ studentQualified: false }), before, buyActionId, [...inputs, { code: "ticketType", value: "学生票" }]);
    expect(outcome.verdict).toBe("BLOCKED");
    expect(outcome.blockers).toHaveLength(1);
    expect(outcome.blockers[0].ruleName).toBe("学生票须持学生资质");
    expect(outcome.blockers[0].evidence).toHaveLength(2);
    expect(outcome.graph.nodes).toHaveLength(2);
    expect(outcome.graph.relationships).toHaveLength(0);
    // 即使被拦截，也仍然告诉调用方"本来会做什么"
    expect(outcome.steps).toHaveLength(3);
  });

  it("全价票放行，并生成对象与两条关系", () => {
    const outcome = runAction(definition({ studentQualified: false }), graph(), buyActionId, [...inputs, { code: "ticketType", value: "全价票" }]);
    expect(outcome.verdict).toBe("PASSED");
    expect(outcome.graph.nodes).toHaveLength(3);
    const ticket = outcome.graph.nodes.find((node) => node.labels.includes("车票"));
    expect(ticket?.properties).toMatchObject({ 票号: "TK-0001", 票种: "全价票" });
    expect(outcome.graph.relationships.map((item) => item.type).sort()).toEqual(["乘坐", "归属于"]);
    expect(outcome.createdEntities[0].display).toBe("TK-0001");
  });

  it("有学生资质时学生票放行", () => {
    const withQualification = graph();
    withQualification.nodes[0].properties["学生资质"] = true;
    const outcome = runAction(definition({ studentQualified: true }), withQualification, buyActionId, [...inputs, { code: "ticketType", value: "学生票" }]);
    expect(outcome.verdict).toBe("PASSED");
  });

  it("处置为提示时不拦截，只给提示", () => {
    const outcome = runAction(definition({ studentQualified: false, effect: "WARN" }), graph(), buyActionId, [...inputs, { code: "ticketType", value: "学生票" }]);
    expect(outcome.verdict).toBe("PASSED");
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.blockers).toHaveLength(0);
  });

  it("停用的规则不参与判断", () => {
    const outcome = runAction(definition({ studentQualified: false, ruleEnabled: false }), graph(), buyActionId, [...inputs, { code: "ticketType", value: "学生票" }]);
    expect(outcome.verdict).toBe("PASSED");
  });

  it("沿关系找邻域对象做条件判断", () => {
    const withTicket = graph();
    const existingTicketId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    withTicket.nodes.push({ id: existingTicketId, labels: ["车票"], properties: { 票号: "TK-OLD", 票种: "学生票" } });
    withTicket.relationships.push({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sourceId: existingTicketId, targetId: passengerId, type: "归属于", properties: {} });
    const strict = definition({ studentQualified: false });
    strict.rules[0].conditions = [
      { subject: { kind: "PARAM", code: "train", relationshipTypeId: "", direction: "OUT" }, property: "车次号", operator: "EQUALS", compareValue: "G1" },
      { subject: { kind: "PARAM", code: "passenger", relationshipTypeId: ownsTypeId, direction: "IN" }, property: "票种", operator: "EQUALS", compareValue: "学生票" },
    ];
    const outcome = runAction(strict, withTicket, buyActionId, [...inputs, { code: "ticketType", value: "全价票" }]);
    expect(outcome.verdict).toBe("BLOCKED");
    expect(outcome.blockers[0].evidence[1]).toContain("邻域");
  });

  it("参数不合格时报错而不是静默跳过", () => {
    expect(() => runAction(definition({ studentQualified: false }), graph(), buyActionId, [{ code: "train", entityId: passengerId }, { code: "ticketType", value: "全价票" }]))
      .toThrow(/需要选择一个对象/);
    expect(() => runAction(definition({ studentQualified: false }), graph(), buyActionId, [...inputs]))
      .toThrow(/参数「票种」不能为空/);
  });

  it("定义体检能发现悬空引用", () => {
    const broken = definition({ studentQualified: false });
    broken.actionTypes[0].edits[1].targetRef = { kind: "PARAM", code: "missing" };
    const violations = validateActionDefinition(broken);
    expect(violations.some((item) => item.message.includes("不存在的参数「missing」"))).toBe(true);
  });

  it("主对象：动作定义在乘客上，运行时必须指定乘客", () => {
    const scoped = withScope(definition({ studentQualified: false }));
    expect(() => runAction(scoped, graph(), buyActionId, [...inputs, { code: "ticketType", value: "全价票" }]))
      .toThrow(/请先选择要执行的对象/);
    expect(() => runAction(scoped, graph(), buyActionId, [...inputs, { code: "ticketType", value: "全价票" }], { subjectEntityId: trainId }))
      .toThrow(/只能用在带「乘客」标签的对象上/);
  });

  it("主对象：规则条件可以直接引用主对象", () => {
    const scoped = withScope(definition({ studentQualified: false }));
    scoped.rules[0].conditions = [
      { subject: { kind: "SUBJECT", code: "", relationshipTypeId: "", direction: "OUT" }, property: "学生资质", operator: "IS_FALSY", compareValue: "" },
    ];
    const outcome = runAction(scoped, graph(), buyActionId, [...inputs, { code: "ticketType", value: "全价票" }], { subjectEntityId: passengerId });
    expect(outcome.verdict).toBe("BLOCKED");
    expect(outcome.subject).toMatchObject({ id: passengerId, label: "乘客", display: "张三" });
    expect(outcome.blockers[0].evidence[0]).toContain("主对象");
  });

  it("主对象：操作可以直接改主对象", () => {
    const scoped = withScope(definition({ studentQualified: false }));
    scoped.actionTypes[0].edits = [
      { op: "SET_PROPERTY", alias: "", entityTypeId: "", relationshipTypeId: "", entityRef: { kind: "SUBJECT", code: "" }, sourceRef: { kind: "PARAM", code: "" }, targetRef: { kind: "PARAM", code: "" }, assignments: [
        { property: "学生资质", value: { kind: "PARAM", code: "ticketType", value: "" } },
      ] },
    ];
    const outcome = runAction(scoped, graph(), buyActionId, [...inputs, { code: "ticketType", value: "true" }], { subjectEntityId: passengerId });
    expect(outcome.verdict).toBe("PASSED");
    expect(outcome.graph.nodes.find((node) => node.id === passengerId)?.properties["学生资质"]).toBe(true);
  });

  it("定义体检：动作没选作用的类会被报出来", () => {
    const violations = validateActionDefinition(definition({ studentQualified: false }));
    expect(violations.some((item) => item.message.includes("需要选择作用的对象类型"))).toBe(true);
  });

  it("旧数据的「级别 + 闸门」读出来归一成处置", () => {
    const base = definition({ studentQualified: false });
    const legacy = (severity: "BLOCKER" | "WARNING", gate: boolean) => ontologyDefinitionSchema.parse({
      ...base,
      rules: [{ id: studentRuleId, name: "旧规则", severity, gate, priority: 1, enabled: true, actionId: buyActionId, conditions: [], message: "" }],
    }).rules[0].effect;
    expect(legacy("BLOCKER", true)).toBe("BLOCK");
    expect(legacy("BLOCKER", false)).toBe("WARN");
    expect(legacy("WARNING", true)).toBe("WARN");
  });

  const subjectCondition = { subject: { kind: "SUBJECT" as const, code: "", relationshipTypeId: "", direction: "OUT" as const }, property: "学生资质", operator: "IS_FALSY" as const, compareValue: "" };

  it("隐藏：命中时动作不出现在这个对象上，但不拦执行", () => {
    const scoped = withScope(definition({ studentQualified: false, effect: "HIDE", ruleConditions: [subjectCondition] }));
    const visibility = visibleActions(scoped, graph(), passengerId);
    expect(visibility).toHaveLength(1);
    expect(visibility[0].visible).toBe(false);
    expect(visibility[0].findings[0].effect).toBe("HIDE");

    const qualified = graph();
    qualified.nodes[0].properties["学生资质"] = true;
    expect(visibleActions(scoped, qualified, passengerId)[0].visible).toBe(true);

    // 隐藏只影响"出不出来"，不是写入闸门：真去执行也照常通过，只是如实报出来。
    const outcome = runAction(scoped, graph(), buyActionId, [...inputs, { code: "ticketType", value: "全价票" }], { subjectEntityId: passengerId });
    expect(outcome.verdict).toBe("PASSED");
    expect(outcome.hidden).toHaveLength(1);
    expect(outcome.blockers).toHaveLength(0);
  });

  it("隐藏：条件引用入参或本次新建对象时不算命中（动作还没跑，值还不存在）", () => {
    const scoped = withScope(definition({ studentQualified: false, effect: "HIDE" }));
    expect(visibleActions(scoped, graph(), passengerId)[0].visible).toBe(true);
  });

  it("隐藏：可以沿关系看一度邻域", () => {
    const withTicket = graph();
    const ticketId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    withTicket.nodes.push({ id: ticketId, labels: ["车票"], properties: { 票号: "TK-OLD", 票种: "学生票" } });
    withTicket.relationships.push({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sourceId: ticketId, targetId: passengerId, type: "归属于", properties: {} });
    const scoped = withScope(definition({ studentQualified: false, effect: "HIDE", ruleConditions: [
      { subject: { kind: "SUBJECT", code: "", relationshipTypeId: ownsTypeId, direction: "IN" }, property: "票种", operator: "EQUALS", compareValue: "学生票" },
    ] }));
    expect(visibleActions(scoped, withTicket, passengerId)[0].visible).toBe(false);
    expect(visibleActions(scoped, graph(), passengerId)[0].visible).toBe(true);
  });

  it("定义体检：隐藏规则必须绑定动作，条件只能看主对象", () => {
    const loose = withScope(definition({ studentQualified: false, effect: "HIDE", ruleConditions: [subjectCondition] }));
    loose.rules[0].actionId = "";
    expect(validateActionDefinition(loose).some((item) => item.message.includes("需要绑定到一个具体动作"))).toBe(true);

    const wide = withScope(definition({ studentQualified: false, effect: "HIDE" }));
    expect(validateActionDefinition(wide).some((item) => item.message.includes("条件只能看主对象"))).toBe(true);
  });
});
