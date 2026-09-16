# miaoworkflow

> 内部简称：**mwf**

工作流编排项目。目前只有目录骨架，实现尚未开始。

公开仓库：https://github.com/KkSss999/miaoworkflow

## 状态

| 项 | 状态 |
|---|---|
| 项目骨架 | 已建（本文件 / `AGENTS.md` / `.gitignore`） |
| 技术栈 | 未定 |
| 代码 | 无 |

## 目录

```text
5k2m/
├── case-01/        # IntakeOps
├── case-02/
└── miaoworkflow/   # 本项目
    ├── AGENTS.md   # 给 AI/协作者的约定
    ├── README.md
    └── .gitignore
```

## 待定

- 语言与运行时（TypeScript / Python）
- 是否 monorepo（`packages/` + `apps/`），参照 `voxo`
- mwf 与同级 `case-01`（IntakeOps）的关系：独立项目，还是作为其 workflow 层
