import type { ResolvedCaseExpression, ResolvedCaseValue, ResolvedExpr, ResolvedField, ResolvedScalar } from "../ast";

/** CASE 结构只有一份；后端只提供条件、属性和绑定值的物理写法。 */
export function compileCaseExpression(expression: ResolvedCaseExpression, dialect: {
  condition: (condition: ResolvedExpr) => string;
  field: (field: ResolvedField) => string;
  literal: (value: ResolvedScalar, allNull: boolean) => string;
}) {
  const operands = [...expression.branches.map((branch) => branch.then), expression.otherwise];
  const allNull = operands.every((operand) => operand.kind === "literal" && operand.value === null);
  const value = (operand: ResolvedCaseValue) => operand.kind === "field" ? dialect.field(operand.field) : dialect.literal(operand.value, allNull);
  return `CASE ${expression.branches.map((branch) => `WHEN ${dialect.condition(branch.when)} THEN ${value(branch.then)}`).join(" ")} ELSE ${value(expression.otherwise)} END`;
}

/** 数字参数转为十进制文本，避免 CH 将数值分支推断成 String 或 Float64。 */
export function decimalLiteral(value: number) {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const scale = Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
  if (scale > 30) throw new Error("CASE 数字常量的小数位超过 30 位，请改为已定义数值属性。");
  return { text: value.toFixed(scale), scale };
}
