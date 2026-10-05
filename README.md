# 皮影戏排演编排台（gbshadowplay）

面向皮影戏班社的排练统筹与舞台监督工具：把一出台戏拆成场次，为每个影人角色指定操耍人与锣鼓点，并跟踪各场次的排练成熟度；另设「巡演授权对账」，把外部授权书的批准范围（地区 / 日期 / 场次额度）与班社两个分队的本地巡演场次对齐。核心动作是「建剧目 → 拆场次 → 指派影人与操耍人 → 标注锣鼓点 → 推进排练进度」与「登记授权 → 排期预占 → 回执转已用 → 巡演对账」。

纯前端单页应用，**无后端 / 无数据库服务 / 无 API**，所有数据保存在访问者本机浏览器里（IndexedDB）。

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
| 巡演授权对账 | 授权书管外部批准范围（剧目/地区/起止日期/场次额度），巡演批次记本地场次安排；排场次先预占额度、演完回执转已用并冻结依据；越区/超期/超额/缺授权逐场核对，导入失败回滚留待核对、可重开续处理 |

**冲突拦截**：指派操耍人时，会依据该人已排时段与同场其他影人操耍人的时段做重叠判定，冲突的候选人在下拉中直接禁用并给出拦截原因；操耍人自身时段互相重叠也会高亮预警。

### 巡演授权对账规则

- **授权书（外部批准范围）**：按剧目限定批准地区、起止日期与场次总额度；可登记、更新（自动升版本号）、换发新版（旧版标记「已换发」）、废止。
- **巡演批次（本地安排）**：甲队、乙队各排一套场次，两队合起来共用同一份授权额度。
- **预占 → 已用**：排场次即 `held`（预占额度）；导入/登记演出回执后转 `performed`（已用），并在当场冻结当时的授权依据快照（文号、版本、范围、额度、结论）。取消场次释放预占，可重开再次预占。
- **更新后核对**：授权范围/额度更新后，**未演场次按最新授权重新核对**（地区 / 日期 / 额度），**已演批次永久保留演当时的原依据**，不追溯。
- **额度排队**：已演先占额度，在范围内的预占场次按演出日期先后在剩余额度内排队，排不进的判「场次超额」（两队合起来常有场次没额度的场景即在此暴露）。
- **结论分类**：额度内 / 待补授权书（旧剧目缺授权，先列待补）/ 越区 / 超期 / 场次超额。
- **导入幂等与回滚**：授权书、排期、回执均以 CSV/TSV 导入，整批在一个事务内提交——任一行不通过则**整批回滚、恢复原额度**，原始文件保留为「待核对」批次，修正（如先补排期/补授权）后可**重开继续处理**；回执号及整批文件指纹去重，**重复导入不再占用额度**。

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
npm run build    # tsc --noEmit 类型检查 + vite build（生产构建）
npm run preview  # 本地预览构建产物
npm run test:tour # 巡演授权对账状态机端到端自测（Node + fake-indexeddb）
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
        ├── components/tour/    # AuthorizationFormModal.tsx ImportPanel.tsx ImportBatchesCard.tsx
        ├── hooks/              # useSceneOrder.ts useOperatorConflict.ts
        ├── pages/              # PlayList.tsx SceneBoard.tsx RoleAssign.tsx CueTimeline.tsx OperatorList.tsx TourAuth.tsx
        ├── router/             # index.tsx（路由表 + 懒加载分包）
        ├── utils/              # timecode.ts db.ts export.ts tourRecon.ts tourImport.ts（另有 localStore/seed/uuid 辅助）
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
| `/tour` | 巡演授权对账 | Authorization、TourBatch、TourPerformance、ImportBatch |

### 数据模型

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| Play 剧目 | `src/types/play.ts` | id、title、genre、scriptText、totalScenes、premiereVenue、status |
| Scene 场次 | `src/types/scene.ts` | id、playId、seq、title、durationMin、stageNote、needsShadowScreen、progress |
| ShadowRole 影人角色 | `src/types/role.ts` | id、sceneId、name、roleType、propParts、entranceCue、lineNote、operatorId |
| Operator 操耍人 | `src/types/operator.ts` | id、name、skillTags、busySlots、assignedRoleIds、rehearsalHours |
| PercussionCue 锣鼓点 | `src/types/cue.ts` | id、sceneId、beatName、instrument、atSecond、leadOperator、note |
| Authorization 授权书 | `src/types/tour.ts` | id、docNo、playId/playTitle、regions、validFrom、validTo、quota、versionNo、status（active/superseded/revoked） |
| TourBatch 巡演批次 | `src/types/tour.ts` | id、name、team（teamA/teamB）、planFrom、planTo |
| TourPerformance 巡演场次 | `src/types/tour.ts` | id、batchId、playId、showDate、region、venue、state（held/performed/cancelled）、matchedAuthId、basis（已演冻结快照）、receiptNo |
| ImportBatch 导入记账 | `src/types/tour.ts` | id、kind（auth/schedule/receipt）、status（success/failed/pending）、idempotencyKey、rawRows、results、affectedIds |

---

## 六、数据存储说明

- **IndexedDB（Dexie）**：`src/utils/db.ts` 封装全部读写，数据库名 `gbshadowplay`，当前结构版本 **3**；v2 提供过 `revision` 行修订号迁移，v3 新增巡演对账四表（`authorizations` / `tourBatches` / `tourPerformances` / `importBatches`），老五表结构不变、历史数据平滑保留。
- **localStorage**：`src/utils/localStore.ts` 统一封装界面偏好（最近打开的剧目、场次页「只看本次勾选」开关等）。
- **首次打开**：数据库为空时自动灌入示例班社数据（3 出剧目 / 6 个场次 / 12 个影人角色 / 4 位操耍人 / 10 处锣鼓点），保证界面开箱即有内容可点。
- **导入导出**：剧目库支持导出整库 JSON 存档（含巡演四表）、导入存档覆盖、以及重置为示例数据；操耍人档支持导出 CSV，剧目可导出排练通告 CSV；巡演页支持授权书 / 排期 / 回执 CSV 模板下载与导入，失败回滚留待核对、可重开续处理。
- **巡演逻辑自测**：`npm run test:tour` 用 esbuild + fake-indexeddb 在 Node 内端到端验证预占/转已用/冻结依据/幂等/回滚重开等规则（测试位于 `frontend/test/`，不进入生产构建）。
- **容器无状态**：数据只存在访问者的浏览器里，不使用数据库服务、不挂载命名卷；清除站点数据即等于恢复出厂状态。

---

## 七、容器化要点

- `frontend/Dockerfile`：多阶段构建，`node:20-alpine` 执行 `npm ci` 与 `npm run build`（`tsc -b` 类型检查通过），产物交给 `nginx:alpine` 托管。
- `frontend/nginx.conf`：`try_files $uri $uri/ /index.html;` 支持前端路由直接刷新，开启 gzip（含 JS/CSS/JSON/SVG/字体等类型），静态指纹资源长缓存、入口 HTML 不缓存。
- `docker-compose.yml`：不写 `version:` 字段；顶层 `name: gbshadowplay`；服务 `frontend` 使用 `container_name: ${COMPOSE_PROJECT_NAME:-gbshadowplay}-frontend`；端口映射 `"${FRONTEND_PORT:-21802}:80"`。
- 端口：宿主 `21802` → 容器 `80`。
