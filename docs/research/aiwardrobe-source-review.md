# AIWardrobe 源码核查

核查日期：2026-10-20。核查对象：`leoz9/AIWardrobe`，实际克隆并阅读的提交为 [`9a25eca94faa4ebe815a9660eeb94e5513532319`](https://github.com/leoz9/AIWardrobe/tree/9a25eca94faa4ebe815a9660eeb94e5513532319)。结论来自 README 与代码静态核查；未部署该项目、未实测模型效果或内存峰值。文中“建议”是针对家庭两人、少量衣物、2 核 2 GB 服务器的设计判断。

## 1. 实际功能与边界

| 功能 | 实现情况 | 家庭系统取舍 |
| --- | --- | --- |
| 衣物照片录入 | 图片上传、抠图、视觉识别、自动保存，再编辑名称/类别/标签/描述 | 保留照片、字段编辑；改为先保存、AI 可选 |
| 我的衣柜 | 上装/下装/鞋/配饰四类，前端按名称或描述搜索、季节和风格筛选、删除 | 保留；增加成员归属和家庭权限 |
| 衣物详情 | 图片与语义标签展示；选取本人照片后调用试穿 | 保留详情；首期去掉试穿 |
| 手动搭配 | 按季节筛选，上下装与鞋逐项切换、随机组合，纯前端状态 | 可选保留；原实现没有持久化套装收藏/穿着记录 |
| 天气与城市 | Open-Meteo 当前天气，Open-Meteo 与 Nominatim 地理编码，SQLite 缓存 | 保留天气/缓存思想；固定家庭城市可直接存经纬度 |
| 推荐 | 温度与季节规则筛选，再按场景、幸运色、星座风格等打分，各类选一件 | 保留规则基础，但重做成员/洗衣/轮换约束 |
| 大模型推荐说明 | 将已经选好的衣物、天气、缺失项发送给 LLM 写 Markdown 文案 | 可选；规则解释已经可用 |
| 星座运势 | aztro 来源、失败使用固定规则生成内容、每日缓存、可选 LLM 解读 | 可以全部不要 |
| 语音目标 | 浏览器 SpeechRecognition/webkitSpeechRecognition 转为目标文本 | 可不要，依赖浏览器支持；手机键盘语音已能替代 |
| AI 试穿 | 自定义 HTTP 接口适配，传入人物图和衣物图，接受 URL/图片/base64 | 不是内置模型；首期不要 |
| 设置/国际化/主题 | 模型地址和 Key、抠图、城市、星座、试穿；中英日与主题 | 复用现有系统配置，不迁入独立设置中心 |

证据：[页面路由](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/frontend/src/App.jsx#L16)、[录入编辑](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/frontend/src/pages/Entry.jsx)、[衣柜与筛选](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/frontend/src/pages/Wardrobe.jsx)、[手动搭配](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/frontend/src/pages/Outfit.jsx#L122)、[浏览器语音](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/frontend/src/pages/Recommendation.jsx#L36)。

## 2. 推荐并非大模型直接挑衣服

实际链路为：读取整个衣柜 → 获取天气与星座 → 将体感温度分档，映射允许季节 → 按类别筛选 → 分别打分挑选上装、下装、鞋 → 选择配饰/生成缺失补购提示 → LLM 将既定选择写成说明。LLM 没有拿全部衣柜自行选择 ID。`balanced`、`goal_first`、`wardrobe_first` 是改变评分权重，不是三套智能体。

鞋类无季节匹配项时会回退到全部现有鞋类。上装与下装缺少合适季节标签时直接生成补购提示。未填季节的上/下装不会进入候选，因此“没有录完整”可能被误当作“需要买”。评分没有整套颜色协调、连衣裙替代上下装、内搭加外套、洗衣状态、成员归属或近期穿过的惩罚。同分保留首个候选；数据库按创建时间倒序读取，因此推断容易重复推荐新录入衣服。

LLM 无 Key、调用失败或超过 20 秒时，回退本地规则文本。对少量家庭衣物，规则推荐可以独立交付价值，LLM 文案不是必须依赖。源码：[温度规则](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/recommendation.py#L78)、[评分](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/recommendation.py#L207)、[选衣主链路](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/recommendation.py#L373)、[LLM 文案](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/recommendation.py#L548)、[衣柜读取顺序](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/storage/db.py#L78)。

## 3. AI 录入是强依赖，需要改成增强能力

上传 API 先检查声明的 MIME 为图片，再把文件全部读入内存。随后同步执行本地 rembg，或调用 remove.bg，失败再回退本地。抠图之后必须调用 OpenAI 兼容视觉接口，成功才将 PNG 写磁盘并写数据库。没有手工直接新建衣物 API，也没有识别失败保存草稿的分支；编辑只发生在成功自动创建以后。不能把“没配置 AI 也能完整管理衣柜”当成源项目已有能力。

识别输入是整张处理后的 PNG base64，超时 60 秒、输出最多 1,000 token，返回 JSON 经 Pydantic 转模型。实际上传代码固定调用 `analyze_clothes_openai`。虽然仓库有 Gemini 服务和依赖，其存在不代表现有上传链路会自动切换原生 Gemini API。

建议：原图或压缩图先私有保存，允许手填类别/颜色/季节后立即使用；AI 只在录入时补全一次，不随列表打开重算；抠图独立于识别，不抠图也可识别。模型给出的材质、保暖、季节只是推测，需可改；不能从照片可靠得出精确成分、防水等级或实际保暖能力。

证据：[上传主链路](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/api/upload.py#L24)、[视觉 API](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/openai_compatible.py#L89)、[抽取字段](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/domain/prompts.py)、[本地抠图](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/segment.py)、[Gemini 实现](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/gemini.py)。

## 4. 不应直接移植的部署与权限设计

- 独立项目采用 React/Vite、FastAPI、SQLite，与家常账技术栈不同；完整并排部署会增加另一套服务、配置和备份。建议只迁产品流程和规则，写入现有 Vue/NestJS/PostgreSQL 体系。
- `requirements.txt` 默认包含 rembg、onnxruntime；Docker 安装这些依赖并运行 Python 服务。没有测得该应用内存峰值，不能承诺会超 2 GB，但 CPU 抠图会与现有服务争抢内存/算力，且在 async 上传路由里直接同步执行。建议服务器不跑抠图/视觉/生成模型；普通照片足够，少量图片可在手机或个人电脑预处理。
- `main.py` 未配置鉴权中间件或全局路由鉴权依赖，衣物路由没有账号参数，数据模型没有成员/家庭字段；图片直接挂载公开静态目录。移植必须沿用现有家庭身份校验和私有附件读取，不复制这些访问方式。
- 远程修改 API 配置与安装 rembg 的端点也没有路由鉴权；`/install-rembg` 直接启动 pip。应彻底去掉浏览器安装依赖功能；服务商密钥由现有服务器配置管理。
- 上传处理结果先写磁盘再写数据库，失败无清理补偿；删除数据库记录也未删除图片。需要沿用本系统文件生命周期管理，避免孤儿图。

证据：[入口和静态资源](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/main.py#L44)、[数据表](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/storage/models.py#L7)、[衣柜 CRUD](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/api/wardrobe.py)、[删除实现](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/storage/db.py#L118)、[远程安装端点](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/api/config.py#L57)、[依赖](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/requirements.txt)、[Dockerfile](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/Dockerfile)。

## 5. 天气与试穿的特别边界

天气实现有小时桶缓存、地点解析缓存、失败返回旧缓存，值得保留。但没有任何缓存且服务失败时，会返回固定晴天、20℃、体感22℃与固定观测时间的模拟天气。正式家庭系统应返回“天气暂不可用”或清楚标识旧数据，允许手选；不能用模拟天气驱动推荐。证据：[天气缓存及兜底](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/weather.py#L781)。

试穿服务默认 disabled，只是向自定义地址发送人物和衣服图片，等待最多 120 秒，再解析返回图片/URL/base64。没有内置模型、模型权重、效果保证或统一供应商接入。两人家庭首期没有必要为这个扩展点增加成本和人物照片外发。证据：[试穿接口适配](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/services/tryon.py#L31)、[试穿路由](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/backend/api/tryon.py#L21)。

## 6. 复用与落地结论

项目许可证为 MIT；复制其代码或实质性部分应保留原版权和许可声明。第三方模型、服务和依赖仍各自适用其条款，仓库 MIT 不能覆盖外部服务。证据：[LICENSE](https://github.com/leoz9/AIWardrobe/blob/9a25eca94faa4ebe815a9660eeb94e5513532319/LICENSE)。

家庭首期宜保留照片衣柜、成员归属、分类/季节/颜色编辑、搜索筛选、手动搭配、可解释的天气/场景规则推荐。AI 仅承担可选的一次性图片标签提取；抠图、LLM 说明、语音、星座、试穿都不是衣柜可用性的前置条件。后续更有实用价值的增量是洗衣/收纳状态、套装收藏与穿着记录，再联动已有待办、日历和服饰消费记录。
