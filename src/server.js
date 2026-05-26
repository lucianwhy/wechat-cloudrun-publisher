const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const axios = require("axios");
const express = require("express");
const FormData = require("form-data");
const { marked } = require("marked");
const sharp = require("sharp");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const PORT = Number(process.env.PORT || 80);
const DEFAULT_AUTHOR = process.env.WECHAT_AUTHOR || "";
const ENABLE_COMMENT = String(process.env.WECHAT_ENABLE_COMMENT || "true") === "true";
const ONLY_FANS_CAN_COMMENT = String(process.env.WECHAT_ONLY_FANS_CAN_COMMENT || "false") === "true";
const ENABLE_ORIGINAL_DECLARATION =
  String(process.env.WECHAT_ENABLE_ORIGINAL_DECLARATION || "true") === "true";

marked.setOptions({
  gfm: true,
  breaks: false,
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`Missing required environment variable: ${name}`);
    err.statusCode = 500;
    throw err;
  }
  return value;
}

function buildDigest(title, sourceText) {
  const plain = sourceText.replace(/\s+/g, " ").trim();
  if (!plain) {
    return `${title}。`;
  }
  const digest = `${title}。${plain}`;
  return digest.slice(0, 120);
}

function wrapWechatHtml(contentHtml) {
  return `
<section style="font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif;">
  <div style="font-size:16px;line-height:2;color:#222222;text-align:justify;">
    ${contentHtml}
  </div>
</section>`.trim();
}

function renderMarkdown(markdown) {
  const html = marked.parse(markdown || "");
  return wrapWechatHtml(html);
}

function normalizeHtml(html) {
  return wrapWechatHtml(html || "");
}

async function fetchAccessToken() {
  const appid = requireEnv("WECHAT_APPID");
  const secret = requireEnv("WECHAT_SECRET");
  const response = await axios.get("https://api.weixin.qq.com/cgi-bin/token", {
    params: {
      grant_type: "client_credential",
      appid,
      secret,
    },
    timeout: 30000,
  });

  if (!response.data.access_token) {
    const err = new Error(`Failed to fetch access token: ${JSON.stringify(response.data)}`);
    err.statusCode = 502;
    throw err;
  }

  return response.data.access_token;
}

async function writeTempFile(buffer, ext) {
  const filename = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(os.tmpdir(), filename);
  await fs.promises.writeFile(filepath, buffer);
  return filepath;
}

async function resolveImageBuffer({ imageUrl, imageBase64 }) {
  if (imageBase64) {
    return Buffer.from(imageBase64.replace(/^data:.+;base64,/, ""), "base64");
  }
  if (imageUrl) {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }
  return null;
}

async function cropCoverToWechat(buffer) {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Invalid cover image");
  }

  const width = metadata.width;
  const targetHeight = Math.round(width * 9 / 16);
  const safeTop = Math.max(0, Math.min((metadata.height - targetHeight) / 2, metadata.height - targetHeight));

  return image
    .extract({
      left: 0,
      top: Math.round(safeTop),
      width,
      height: Math.min(targetHeight, metadata.height),
    })
    .png()
    .toBuffer();
}

async function uploadMultipart(url, filePath, field = "media") {
  const form = new FormData();
  form.append(field, fs.createReadStream(filePath));
  const response = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });
  return response.data;
}

async function uploadCoverMaterial(accessToken, coverBuffer) {
  const coverPath = await writeTempFile(coverBuffer, "png");
  try {
    const url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=image`;
    const data = await uploadMultipart(url, coverPath);
    if (!data.media_id) {
      throw new Error(`Cover upload failed: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    fs.promises.unlink(coverPath).catch(() => {});
  }
}

async function uploadContentImage(accessToken, imageBuffer) {
  const imagePath = await writeTempFile(imageBuffer, "png");
  try {
    const url = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;
    const data = await uploadMultipart(url, imagePath);
    if (!data.url) {
      throw new Error(`Content image upload failed: ${JSON.stringify(data)}`);
    }
    return data.url;
  } finally {
    fs.promises.unlink(imagePath).catch(() => {});
  }
}

async function replaceRemoteImages(accessToken, html) {
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const matches = [...html.matchAll(imgRegex)];
  let output = html;

  for (const match of matches) {
    const src = match[1];
    if (!/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) {
      continue;
    }

    const imageBuffer = await resolveImageBuffer({
      imageUrl: /^https?:\/\//i.test(src) ? src : undefined,
      imageBase64: /^data:image\//i.test(src) ? src : undefined,
    });

    if (!imageBuffer) {
      continue;
    }

    const wechatUrl = await uploadContentImage(accessToken, imageBuffer);
    output = output.replace(src, wechatUrl);
  }

  return output;
}

async function createDraft(accessToken, payload) {
  const response = await axios.post(
    `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`,
    payload,
    {
      timeout: 60000,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );

  return response.data;
}

function buildPreviewDocument({ title, digest, coverImageUrl, contentHtml }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body{margin:0;padding:24px 12px 48px;background:#f3efe8;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#222}
    .wrap{max-width:760px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.06)}
    .cover{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#ddd}
    .inner{padding:28px 22px 34px}
    h1{margin:0 0 12px;font-size:28px;line-height:1.45}
    .digest{margin:0 0 24px;font-size:14px;line-height:1.8;color:#888}
  </style>
</head>
<body>
  <div class="wrap">
    ${coverImageUrl ? `<img class="cover" src="${coverImageUrl}" alt="">` : ""}
    <div class="inner">
      <h1>${title}</h1>
      <p class="digest">${digest || ""}</p>
      ${contentHtml}
    </div>
  </div>
</body>
</html>`;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "wechat-cloudrun-publisher",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/wechat/preview", async (req, res, next) => {
  try {
    const { title = "Untitled", markdown = "", html = "", digest = "", coverImageUrl = "" } = req.body || {};
    const contentHtml = html ? normalizeHtml(html) : renderMarkdown(markdown);
    const previewDigest = digest || buildDigest(title, markdown || html || "");

    res.json({
      ok: true,
      title,
      digest: previewDigest,
      contentHtml,
      previewHtml: buildPreviewDocument({
        title,
        digest: previewDigest,
        coverImageUrl,
        contentHtml,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/wechat/publish-draft", async (req, res, next) => {
  try {
    const {
      title,
      markdown = "",
      html = "",
      digest = "",
      coverImageUrl = "",
      coverImageBase64 = "",
      author = DEFAULT_AUTHOR,
      contentSourceUrl = "",
    } = req.body || {};

    if (!title) {
      const err = new Error("title is required");
      err.statusCode = 400;
      throw err;
    }
    if (!markdown && !html) {
      const err = new Error("markdown or html is required");
      err.statusCode = 400;
      throw err;
    }
    if (!coverImageUrl && !coverImageBase64) {
      const err = new Error("coverImageUrl or coverImageBase64 is required");
      err.statusCode = 400;
      throw err;
    }

    const accessToken = await fetchAccessToken();
    let contentHtml = html ? normalizeHtml(html) : renderMarkdown(markdown);
    contentHtml = await replaceRemoteImages(accessToken, contentHtml);

    const coverBufferRaw = await resolveImageBuffer({
      imageUrl: coverImageUrl,
      imageBase64: coverImageBase64,
    });
    if (!coverBufferRaw) {
      const err = new Error("failed to resolve cover image");
      err.statusCode = 400;
      throw err;
    }

    const coverBuffer = await cropCoverToWechat(coverBufferRaw);
    const coverUpload = await uploadCoverMaterial(accessToken, coverBuffer);
    const finalDigest = digest || buildDigest(title, markdown || html || "");

    const article = {
      title,
      author,
      digest: finalDigest,
      content: contentHtml,
      content_source_url: contentSourceUrl,
      thumb_media_id: coverUpload.media_id,
      need_open_comment: ENABLE_COMMENT ? 1 : 0,
      only_fans_can_comment: ONLY_FANS_CAN_COMMENT ? 1 : 0,
      show_cover_pic: 1,
    };

    if (ENABLE_ORIGINAL_DECLARATION) {
      article.copyright_type = 1;
    }

    const draftResponse = await createDraft(accessToken, { articles: [article] });
    res.json({
      ok: true,
      title,
      digest: finalDigest,
      thumbMediaId: coverUpload.media_id,
      draftResponse,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    ok: false,
    message: error.message || "Internal Server Error",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`wechat-cloudrun-publisher listening on ${PORT}`);
});
