# HTTPS 证书申请与应用指南

本文适用于家常账当前的 Ubuntu、Docker Compose、Nginx 部署。证书由 Let's Encrypt 签发，Certbot 通过 HTTP-01 验证域名并自动续期。Cloudflare 可以继续管理 DNS；完成服务器 HTTPS 验收后，再关闭代理以使用直连。

## 1. 部署结构与前提

服务器源码目录为 `/home/homedata/app/current`，Compose 目录为其下的 `deploy`。从本机进入服务器：

```powershell
ssh.exe homedata-server
```

准备条件：域名已指向这台服务器；云安全组允许入站 TCP 80 和 443；服务器能访问 Let's Encrypt 的 ACME 服务；应用当前可通过 HTTP 访问。HTTP-01 首次申请和后续续期都需要公网 80 端口。

Cloudflare 橙云可以在申请期间保持开启，前提是它会把 `/.well-known/acme-challenge/` 原样转发到这台服务器，不对该路径启用缓存、登录验证、验证码或拦截规则。多个 A/AAAA 记录必须指向能响应验证的同一套服务，不要保留错误的 IPv6 记录。

以下命令在服务器执行。首次进入时输入实际域名和证书账户邮箱；它们只保留在当前终端变量中，不要把真实凭证写入仓库：

```bash
cd /home/homedata/app/current
read -r -p 'HTTPS 域名（不带协议和路径）: ' SITE_DOMAIN
read -r -p '证书账户邮箱: ' CERT_EMAIL
```

## 2. 发布 HTTPS 配置文件

先按[服务器部署手册](服务器部署交接说明.md)发布已经推送到 `origin/dev` 的代码，确保存在：

```text
deploy/https/setup.sh
deploy/https/bootstrap.override.yaml
deploy/https/compose.override.yaml
deploy/https/nginx-https.conf.template
deploy/https/reload-nginx.sh
```

本次 HTTPS 配置不改变应用代码或数据库，不需要构建镜像。脚本将已有镜像与只读配置、证书挂载结合使用，只重建 Web 容器；数据库、API、worker 保持运行。Web 切换期间可能有短暂连接中断。

服务器上的 `deploy/compose.override.yaml` 由脚本创建并被 Git 忽略，普通 `docker compose --env-file .env ...` 会自动加载它，后续源码包解压不会覆盖它。若已有自定义 override，脚本会停止，必须先合并配置。不要用单独的 `-f compose.yaml` 启动网站，否则会漏掉 HTTPS 配置；需要显式指定文件时，同时传入 `-f compose.override.yaml`。

## 3. 安装 Certbot

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends certbot
certbot --version
```

不需要在服务器另装 Nginx，也不需要 Cloudflare API Token。网站继续使用 Docker 中的 Nginx。

## 4. 一次执行申请和应用

```bash
cd /home/homedata/app/current
bash -n deploy/https/setup.sh
sudo bash deploy/https/setup.sh "$SITE_DOMAIN" "$CERT_EMAIL"
```

脚本会依次完成：

1. 检查目录、依赖和既有 Compose override，保留 `.env`、`runtime.env` 与业务数据。
2. 创建 `/home/docker/homedata/acme/.well-known/acme-challenge/`。
3. 挂载 HTTP 验证目录和 Nginx 配置，测试配置并重建 Web 容器。
4. 用唯一的临时文件验证公网域名确实能访问这台服务器的验证目录。
5. 用 Let's Encrypt 测试环境演练申请，避免配置错误消耗正式签发额度。
6. 申请正式证书，生成 HTTPS 配置，挂载整个证书目录，发布 443 端口。
7. 检查 HTTPS Nginx 配置，通过本机直连验证证书、域名和 API 健康状态。
8. 安装续期后的 Nginx 重载钩子，启用 Certbot 定时器，演练续期及重载。

脚本通过 `--agree-tos` 同意 Let's Encrypt 的服务条款，应在确认接受条款后执行。出现 `HTTPS_SETUP_COMPLETE` 才表示服务器侧配置及续期演练全部完成。它不代表云安全组或 Cloudflare 已完成调整，仍需后面的公网验收。

脚本针对首次配置；成功后不要重复执行。更新或续期使用后文命令。如果申请中途失败且只留下 bootstrap 配置，可以排除原因后重试。若已经启用 HTTPS，只需继续检查和续期，不要回退申请流程。

## 5. 申请到的证书及 Nginx 应用方式

正式证书保存在：

```text
/etc/letsencrypt/live/你的域名/fullchain.pem
/etc/letsencrypt/live/你的域名/privkey.pem
```

`fullchain.pem` 是证书链；`privkey.pem` 是私钥，不要发送到聊天、提交到 Git 或给普通用户开放读取。`live` 中通常是指向 `archive` 的符号链接，因此容器只读挂载整个 `/etc/letsencrypt`，不能仅挂载一个 PEM 文件，否则续期后可能仍读取旧证书。

应用中的文件与用途：

| 路径 | 用途 |
| --- | --- |
| `/home/docker/homedata/acme` | HTTP-01 验证目录，后续续期继续使用 |
| `/home/docker/homedata/tls/nginx-https.conf` | 按实际域名生成的 HTTPS 配置 |
| `deploy/compose.override.yaml` | 挂载配置、证书和验证目录，发布 443 |
| `/etc/letsencrypt/renewal/你的域名.conf` | Certbot 自动记录的续期参数 |
| `/etc/letsencrypt/renewal-hooks/deploy/homedata-nginx` | 成功续期后检查并重载 Nginx |

HTTPS 配置使用 TLS 1.2/1.3，保留原来的页面和 API 反向代理。HTTP IP 备用入口继续使用 80，不强制整站跳转，以保留现有备用访问方式。请明确通过 `https://` 域名登录；当前没有启用 HTTP 域名登录。

运行配置应保留已有的 HTTPS 主入口和 HTTP IP 白名单：

```dotenv
APP_ORIGIN=https://你的域名
APP_ADDITIONAL_ORIGINS=http://服务器公网IP
```

仅首次配置或入口变化时更新这两个字段，不覆盖整个环境文件。变更后重建 API 容器使新环境生效；单纯 `restart` 不会重新加载环境文件。两个入口使用各自的 Cookie，需要分别登录。

## 6. 验收服务器直连 HTTPS

在服务器上验证本机直连，绕过 Cloudflare，但仍严格校验证书：

```bash
curl --fail --resolve "$SITE_DOMAIN:443:127.0.0.1" \
  "https://$SITE_DOMAIN/api/v1/health/ready"
sudo certbot certificates
```

在另一台电脑上验证公网直连。将 `ORIGIN_IP` 设为服务器公网 IP，不要提交到仓库：

```bash
curl --fail --resolve "$SITE_DOMAIN:443:$ORIGIN_IP" \
  "https://$SITE_DOMAIN/" -o /dev/null
```

以上是 Bash 写法；Windows 可用 `curl.exe --resolve "域名:443:公网IP" "https://域名/"`。不要添加 `-k`，否则无法证明证书可信。

公网直连需返回 200，证书域名匹配且受信任。若本机成功而公网连接超时，先检查云安全组的入站 TCP 443 和服务器防火墙；不要先关闭橙云。

## 7. Cloudflare 切换为仅 DNS

公网直连 HTTPS 验收成功后：

1. 登录 Cloudflare，进入对应站点的 DNS 记录。
2. 确认站点记录指向服务器公网 IP。
3. 将该记录从橙云“已代理”改为灰云“仅 DNS”，保存；如果有 AAAA 或 CNAME，也需要确认它们的目标正确。
4. 等待 DNS 缓存更新后，访问 HTTPS 域名，验证登录、刷新页面、退出和文件访问。
5. 再验证原来的 HTTP IP 备用入口，保留独立登录行为。

切灰云不需要更换 Cloudflare nameserver。浏览器到服务器的 HTTPS 由 Let's Encrypt 证书提供，Cloudflare 只负责 DNS。若仍保留橙云，应将 Cloudflare SSL/TLS 设置为 `Full (strict)`，让 Cloudflare 到服务器也经过有效 HTTPS；先确认所有受同一设置影响的站点都有源站证书。

切换前后的测试应从同一台电脑、同一网络执行，分别记录首页与 API 耗时；服务器本机的毫秒级响应不能代表国内公网速度。

## 8. 自动续期和日常检查

```bash
sudo systemctl is-enabled certbot.timer
sudo systemctl list-timers certbot.timer --no-pager
sudo certbot renew --cert-name "$SITE_DOMAIN" --dry-run --run-deploy-hooks
```

定时器会定期检查证书，Certbot 仅在需要时续期。成功续期后，安装的钩子会先运行 `nginx -t`，再平滑重载；不会重启数据库或 API。如果网站因维护主动停止，钩子不会擅自启动它。维护结束后，新容器启动时会读取更新后的证书。

HTTP-01 自动续期要求域名始终能访问验证目录，继续开放 80，不删除验证目录、证书目录或 `.conf` 续期参数。重载钩子使用当前固定部署目录；迁移服务器或调整源码路径时同步更新它。

检查日志：

```bash
sudo journalctl -u certbot.service --since '7 days ago' --no-pager
sudo tail -n 80 /var/log/letsencrypt/letsencrypt.log
cd /home/homedata/app/current/deploy
docker compose --env-file .env exec -T web nginx -t
docker compose --env-file .env ps web
```

证书有效期以 `certbot certificates` 和证书中的到期时间为准，不依赖固定天数。仅保存账户邮箱不等于有独立的到期告警；应继续定期检查续期状态。

## 9. 常见问题和回退

| 现象 | 排查或处理 |
| --- | --- |
| 验证路径返回网站首页 | 检查 ACME location、只读挂载和 Cloudflare 缓存；验证文件不能被 SPA 路由替代 |
| 申请提示 unauthorized | 核对 DNS A/AAAA、公网 80、代理拦截及验证文件是否返回正确内容 |
| 本机 HTTPS 成功，公网超时 | 检查云安全组和服务器防火墙的 TCP 443 |
| 切灰云后出现证书不可信 | 确认部署的是 Let's Encrypt 正式证书，而非测试证书或 Cloudflare Origin CA |
| 证书更新但浏览器仍见旧证书 | 检查完整目录挂载和 deploy hook 重载结果，确认访问路径是否仍经过 Cloudflare |
| 普通 Compose 命令失去 HTTPS | 检查 `compose.override.yaml` 是否存在、当前目录和 `-f` 参数是否包含 override |

若 HTTPS 配置或容器启动失败，首次安装脚本会恢复 HTTP bootstrap 配置。证书文件会保留，便于排查和恢复。启用后手动回退可把 `https/bootstrap.override.yaml` 复制为 `compose.override.yaml`，再只重建 Web；但这会移除服务器 443，不能在灰云状态下声称 HTTPS 可用。请先根据实际情况恢复 Cloudflare 的可用代理模式或改用 HTTP IP 备用入口，不删除证书与业务数据。

## 官方参考

- [Let's Encrypt 入门](https://letsencrypt.org/getting-started/)
- [HTTP-01 与 DNS-01 验证](https://letsencrypt.org/docs/challenge-types/)
- [Certbot 使用、续期与钩子](https://eff-certbot.readthedocs.io/en/stable/using.html)
- [Cloudflare 代理与仅 DNS](https://developers.cloudflare.com/dns/proxy-status/)
