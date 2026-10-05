# 皮影戏排演编排台（gbshadowplay）

面向皮影戏班社的排练统筹与舞台监督工具：把一出台戏拆成场次，为每个影人角色指定操耍人与锣鼓点，并跟踪各场次的排练成熟度。核心动作是「建剧目 → 拆场次 → 指派影人与操耍人 → 标注锣鼓点 → 推进排练进度」。

纯前端单页应用，**无后端 / 无数据库 / 无 API 服务**，所有数据保存在访问者本机浏览器里。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先准备环境变量
cp .env.example .env

# 2. 一条命令构建并启动
docker compose up -d --build
```

启动后访问：**http://localhost:21802**

常用命令：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f frontend` |
| 停止服务 | `docker compose down` |
| 改名/改端口 | 编辑 `.env` 中的 `COMPOSE_PROJECT_NAME`、`FRONTEND_PORT` 后重新 `docker compose up -d --build` |
| 校验编排文件 | `docker compose config --quiet` |

> 顶层已写 `name: gbshadowplay` 兜底，即使本项目放在中文目录下，`docker compose config --quiet` 也不会因为项目名为空而报错。

---

## 二、项目简介

| 模块 | 说明 |
| --- | --- |
| 剧目库 | 新建剧目、按剧种（传统折子/新编）与状态（筹备中/排练中/可上演）筛选，环形指示展示平均排练成熟度 |
| 场次拆分 | 场序表拖拽调序（自动重排并落库）、按场次勾选「本次排练覆盖范围」、左右相邻场次合计时长参考 |
| 角色指派 | 登记全场影人角色（行当 / 需备影件 / 出场提示 / 唱白要点），为每个角色指派操耍人 |
| 锣鼓点时间轴 | 按秒点插入急急风/四击头/水底鱼，选主奏乐器与领奏操耍人，刻度尺可点击定位、可试排播放 |
| 操耍人档 | 维护技能标签（签子/连本/武打）与冲突时段，查看每人已派角色与累计排练时长，两两时段冲突对比 |
| 巡演授权对账 | 授权书管外部批准范围（地区/日期/场次额度，支持换发版本）；巡演批次记本地安排，两队一池合计额度；排场先预占、回执转已用、重复回执幂等；导入失败整段回滚、断点继续；已演批次保留原依据，未演场次按新授权重核 |

**冲突拦截**：指派操耍人时，会依据该人已排时段与同场其他影人操耍人的时段做重叠判定，冲突的候选人在下拉中直接禁用并给出拦截原因；操耍人自身时段互相重叠也会高亮预警。

---

## 三、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | 18.3 |
| 语言 | TypeScript（`strict`，无 `any`） | 5.6 |
| 构建 | Vite | 5.4 |
| UI 组件 | Ant Design（`@ant-design/icons`） | 5.22 |
| 状态管理 | Zustand | 4.5 |
| 路由 | React Router（`createBrowserRouter`） | 6.28 |
| 本地数据库 | Dexie（IndexedDB 封装，含结构版本号与升级迁移） | 4.0 |
| 容器 | 多阶段构建：`node:20-alpine` → `nginx:alpine` | — |

---

## 四、本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21802
npm run build    # tsc -b && vite build（类型检查 + 生产构建）
npm run preview  # 本地预览构建产物
```

要求 Node.js 20 及以上（Docker 构建阶段固定使用 `node:20-alpine`）。

---

## 五、目录结构

```
sologsb-1102/
├── docker-compose.yml          # 顶层 name + 服务 frontend（不写 version 字段）
├── .env.example / .env         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── README.md
└── frontend/                   # 前端源码
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 + nginx:alpine 托管
    ├── nginx.conf              # SPA fallback（try_files）+ gzip
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    └── src/
        ├── types/              # play.ts scene.ts role.ts operator.ts cue.ts tour.ts
        ├── stores/             # playStore.ts sceneStore.ts operatorStore.ts tourStore.ts（Zustand）
        ├── components/common/  # SceneCard.tsx AssigneePicker.tsx ProgressRing.tsx EmptyState.tsx
        ├── components/tour/    # AuthFormModal.tsx BatchCreateModal.tsx BatchDrawer.tsx
        ├── hooks/              # useSceneOrder.ts useOperatorConflict.ts
        ├── pages/              # PlayList.tsx SceneBoard.tsx RoleAssign.tsx CueTimeline.tsx OperatorList.tsx TourReconcile.tsx
        ├── router/             # index.tsx（路由表 + 懒加载分包）
        ├── utils/              # timecode.ts db.ts export.ts tourReconcile.ts tourImport.ts（另有 localStore/seed/uuid 辅助）
        ├── scripts/ （在 src 外）# verify-tour.ts 巡演对账不变量校验：npm run verify:tour
        ├── styles/main.css     # 皮影暖纸底主题样式
        ├── App.tsx             # 布局与外层导航
        └── main.tsx            # 入口：ConfigProvider(zh_CN) + RouterProvider
```

### 路由表

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plays` | 剧目库 | Play |
| `/plays/:id/scenes` | 场次拆分与调序 | Scene、Play |
| `/scenes/:id/roles` | 角色与操耍人指派 | ShadowRole、Operator |
| `/scenes/:id/cues` | 锣鼓点时间轴 | PercussionCue、Scene |
| `/operators` | 操耍人档与时段冲突 | Operator |
| `/tour` | 巡演授权对账（授权书 / 批次 / 场次） | TourAuthorization、TourBatch、TourShow |

### 数据模型

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| Play 剧目 | `src/types/play.ts` | id、title、genre、scriptText、totalScenes、premiereVenue、status |
| Scene 场次 | `src/types/scene.ts` | id、playId、seq、title、durationMin、stageNote、needsShadowScreen、progress |
| ShadowRole 影人角色 | `src/types/role.ts` | id、sceneId、name、roleType、propParts、entranceCue、lineNote、operatorId |
| Operator 操耍人 | `src/types/operator.ts` | id、name、skillTags、busySlots、assignedRoleIds、rehearsalHours |
| PercussionCue 锣鼓点 | `src/types/cue.ts` | id、sceneId、beatName、instrument、atSecond、leadOperator、note |
| TourAuthorization 授权书 | `src/types/tour.ts` | id、playId、docNo、versionNo、status、regions、dateFrom/dateTo、totalQuota |
| TourBatch 巡演批次 | `src/types/tour.ts` | id、batchNo、troupe、playId、status、scheduleQueue、receiptQueue、receiptLog |
| TourShow 巡演场次 | `src/types/tour.ts` | id、batchId、playId、troupe、region、showDate、status、authId、basis、receiptNo、issues |

---

## 六、数据存储说明

- **IndexedDB（Dexie）**：`src/utils/db.ts` 封装全部读写，数据库名 `gbshadowplay`，当前结构版本 **3**（v3 新增 `authorizations` / `tourBatches` / `tourShows` 三表，旧库打开自动升级，巡演表为空起步）；行修订号 `revision=3`。
- **localStorage**：`src/utils/localStore.ts` 统一封装界面偏好（最近打开的剧目、场次页「只看本次勾选」开关等）。
- **首次打开**：数据库为空时自动灌入示例班社数据（3 出剧目 / 6 个场次 / 12 个影人角色 / 4 位操耍人 / 10 处锣鼓点，以及 4 个巡演批次、2 版授权书与对应场次），保证界面开箱即有内容可点。
- **导入导出**：剧目库支持导出整库 JSON 存档、导入存档覆盖（兼容不含巡演三表的旧快照）、以及重置为示例数据；操耍人档支持导出 CSV，剧目可导出排练通告 CSV。
- **容器无状态**：数据只存在访问者的浏览器里，不使用数据库服务、不挂载命名卷；清除站点数据即等于恢复出厂状态。

### 巡演授权对账规则

- **授权书（外部范围）**：按剧目登记批准地区（精确匹配）、有效期闭区间、场次总额度；两个分队的场次**共用同一额度池**，按演出日期先后逐场预占，超额场记 `QUOTA_OVER` 待核对、不占额度。
- **更新授权**：「修改」用于同版范围/额度调整；「换发新版」自动把旧版置为 `superseded` 留存。更新后**只重核未演场次**——已演场次在演完那一刻冻结 `basis`（文号/版本/地区/日期/额度快照），旧版即使作废也保留为原依据。
- **排场→回执两段导入**：排场次核对通过即**预占**（`reserved`）；回执匹配同批同地区同日期的预占场后**转已用**（`performed`）并冻结依据。回执号全局唯一，重复导入（含跨批次重复）只留 `duplicate` 痕迹，**不再占用额度**；对不上本地场次记 `unmatched`。
- **失败恢复**：排场次/回执导入在单个 Dexie 事务内执行；任一行数据性致命错误（缺地区/日期非法/回执缺号）整段回滚，已预占额度恢复原样，批次与队列保留为 `failed`，错误行下标 `errorOffset` 精确定位；重开批次可「继续处理」（剩余行从头跑）或「丢弃坏行」后继续。业务性问题（超地区/超日期/超额/缺授权书）不致命，建待核对场、不占额度。
- **缺授权待补**：已排入巡演但没有任何授权书的剧目在页面顶部汇总列出，点击即可补办；补办后未演场次自动重核预占。
- **不变量校验**：`npm run verify:tour` 使用 fake-indexeddb 端到端验证回滚恢复、两队合计超额、回执幂等、换发重核与已演冻结等规则。

---

## 七、容器化要点

- `frontend/Dockerfile`：多阶段构建，`node:20-alpine` 执行 `npm ci` 与 `npm run build`（`tsc -b` 类型检查通过），产物交给 `nginx:alpine` 托管。
- `frontend/nginx.conf`：`try_files $uri $uri/ /index.html;` 支持前端路由直接刷新，开启 gzip（含 JS/CSS/JSON/SVG/字体等类型），静态指纹资源长缓存、入口 HTML 不缓存。
- `docker-compose.yml`：不写 `version:` 字段；顶层 `name: gbshadowplay`；服务 `frontend` 使用 `container_name: ${COMPOSE_PROJECT_NAME:-gbshadowplay}-frontend`；端口映射 `"${FRONTEND_PORT:-21802}:80"`。
- 端口：宿主 `21802` → 容器 `80`。
