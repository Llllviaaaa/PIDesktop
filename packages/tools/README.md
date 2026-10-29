# @pid/tools

工具注册表和执行管线，见 [ADR 0008](../../docs/adr/0008-agent-loop-and-sessions.md)。

## 服务

| 键 | 类 | 说明 |
|---|---|---|
| `tools` | `Tools` | `register(definition)` 返回 disposer；`schemas()` 给模型看的列表；`execute(call, env)` 不抛异常 |

## 事件

| 事件 | 方式 | 说明 |
|---|---|---|
| `tools/pre-execute` | serial（异步 bail） | 返回 `{ allow: true }` 或 `{ deny: true, reason }`，没有返回值就放行；可以原地改写 `call.args` |
| `tools/execute` | waterfall | `(call, env, next)`：包裹执行，例如 checkpoint、超时、截断 |
| `tools/result` | emit | 观察结果 |

参数只校验 `required` 和顶层类型。
