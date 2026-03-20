# 多智能体 ReAct 智能问答系统（毕业设计）

## 目录结构

- `server/` Node.js + Express 后端：ReAct 多智能体编排、工具调用、会话记忆
- `web/` React 前端：响应式聊天界面

## 本地开发

```bash
npm install
npm run dev
```

默认：
- 后端：http://localhost:3001
- 前端：http://localhost:5173

## 配置 Kimi（可选）

- 复制示例文件 `server/.env.example` 为 `server/.env`，填入 `KIMI_API_KEY`
- 设置 `LLM_PROVIDER=kimi`，然后重启后端服务

## 文档

- [下一步计划](file:///Users/bytedance/code-self/GraduationProject/docs/next-steps.md)
