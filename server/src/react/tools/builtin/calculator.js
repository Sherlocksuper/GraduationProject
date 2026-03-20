import { createTool } from "../registry.js";

function tokenize(expr) {
  const s = String(expr || "");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      const raw = s.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(raw) && !/^\.\d+$/.test(raw)) {
        throw new Error(`invalid number: ${raw}`);
      }
      tokens.push({ t: "num", v: Number(raw) });
      i = j;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ t: ch });
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected char: ${ch}`);
  }
  return tokens;
}

function toRpn(tokens) {
  const out = [];
  const ops = [];
  const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "u-": 3 };
  const assoc = { "+": "L", "-": "L", "*": "L", "/": "L", "u-": "R" };

  let prev = null;
  for (const tok of tokens) {
    if (tok.t === "num") {
      out.push(tok);
      prev = tok;
      continue;
    }
    if (tok.t === "(") {
      ops.push(tok);
      prev = tok;
      continue;
    }
    if (tok.t === ")") {
      while (ops.length && ops[ops.length - 1].t !== "(") out.push(ops.pop());
      if (!ops.length) throw new Error("mismatched parentheses");
      ops.pop();
      prev = tok;
      continue;
    }
    if (tok.t === "op") {
      const isUnary = tok.v === "-" && (!prev || (prev.t !== "num" && prev.t !== ")"));
      const op = isUnary ? "u-" : tok.v;
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top.t !== "op") break;
        const topOp = top.v;
        const p1 = prec[op];
        const p2 = prec[topOp];
        if (p2 > p1 || (p1 === p2 && assoc[op] === "L")) out.push(ops.pop());
        else break;
      }
      ops.push({ t: "op", v: op });
      prev = tok;
      continue;
    }
    throw new Error("invalid token stream");
  }
  while (ops.length) {
    const top = ops.pop();
    if (top.t === "(" || top.t === ")") throw new Error("mismatched parentheses");
    out.push(top);
  }
  return out;
}

function evalRpn(rpn) {
  const st = [];
  for (const tok of rpn) {
    if (tok.t === "num") {
      st.push(tok.v);
      continue;
    }
    if (tok.t === "op") {
      if (tok.v === "u-") {
        if (st.length < 1) throw new Error("invalid expression");
        st.push(-st.pop());
        continue;
      }
      if (st.length < 2) throw new Error("invalid expression");
      const b = st.pop();
      const a = st.pop();
      if (tok.v === "+") st.push(a + b);
      else if (tok.v === "-") st.push(a - b);
      else if (tok.v === "*") st.push(a * b);
      else if (tok.v === "/") st.push(a / b);
      else throw new Error(`unknown operator: ${tok.v}`);
      continue;
    }
    throw new Error("invalid rpn");
  }
  if (st.length !== 1) throw new Error("invalid expression");
  return st[0];
}

export const calculatorTool = createTool({
  name: "calculator",
  description: "计算简单数学表达式（支持 + - * / 和括号）",
  inputSchema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"]
  },
  handler: async ({ expression }) => {
    const tokens = tokenize(expression);
    const rpn = toRpn(tokens);
    const result = evalRpn(rpn);
    if (!Number.isFinite(result)) throw new Error("result is not finite");
    return { expression: String(expression), result };
  }
});

