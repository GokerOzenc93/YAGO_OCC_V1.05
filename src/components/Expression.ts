export function evaluateExpression(
  expression: string,
  context: Record<string, number>,
  fallback: number = 0
): number {
  try {
    let expr = expression.trim();

    Object.entries(context).forEach(([key, value]) => {
      const regex = new RegExp(`\\b${key}\\b`, 'g');
      expr = expr.replace(regex, value.toString());
    });

    const sanitized = expr.replace(/[^0-9+\-*/().\s]/g, '');

    const result = Function(`"use strict"; return (${sanitized})`)();

    return isNaN(result) ? fallback : result;
  } catch {
    return fallback;
  }
}
