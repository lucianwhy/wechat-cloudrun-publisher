# wechat-cloudrun-publisher

把本地“公众号草稿箱发布”逻辑搬到微信云托管里的最小可用项目。

## 目标

- 跑在微信云托管
- 提供健康检查接口
- 提供文章预览接口
- 提供发布到公众号草稿箱接口
- 使用固定云出口 IP，避开本地 IP 白名单经常变化的问题

## 接口

### `GET /api/health`

健康检查。

### `POST /api/wechat/preview`

输入 Markdown 或 HTML，返回渲染后的预览 HTML。

请求体示例：

```json
{
  "title": "找不到车放哪了？我做了个帮你记位置的小软件",
  "markdown": "# 标题\n\n正文",
  "digest": "可选摘要"
}
```

### `POST /api/wechat/publish-draft`

发布到公众号草稿箱。

请求体示例：

```json
{
  "title": "找不到车放哪了？我做了个帮你记位置的小软件",
  "markdown": "正文 markdown",
  "digest": "可选摘要",
  "coverImageUrl": "https://example.com/cover.png",
  "author": "王皓月"
}
```

也支持：

- `html`：直接传已经渲染好的 HTML
- `coverImageBase64`：直接传封面图片 base64
- `contentSourceUrl`：文章来源链接

## 环境变量

参考 `.env.example`：

- `WECHAT_APPID`
- `WECHAT_SECRET`
- `WECHAT_AUTHOR`
- `WECHAT_ENABLE_COMMENT`
- `WECHAT_ONLY_FANS_CAN_COMMENT`
- `WECHAT_ENABLE_ORIGINAL_DECLARATION`
- `ALLOW_SELF_SIGNED_TLS`

如果云托管环境里对外 HTTPS 请求出现 `self-signed certificate`，可以临时把：

- `ALLOW_SELF_SIGNED_TLS=true`

作为兜底开关使用。正常情况下还是建议保持 `false`。

## 云托管部署

1. 把这个仓库绑定到微信云托管
2. 分支选 `main`
3. 端口填 `80`
4. 在云托管环境变量里填入公众号密钥
5. 发布

## 官方文档

- 微信云托管介绍：
  [https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/basic/intro.html](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/basic/intro.html)
