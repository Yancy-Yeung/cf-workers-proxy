function logError(request, message) {
  console.error(
    `${message}, clientIp: ${request.headers.get(
      "cf-connecting-ip"
    )}, user-agent: ${request.headers.get("user-agent")}, url: ${request.url}`
  );
}

function createNewRequest(request, url, proxyHostname, originHostname) {
  const newRequestHeaders = new Headers(request.headers);
  for (const [key, value] of newRequestHeaders) {
    if (value.includes(originHostname)) {
      newRequestHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${originHostname}\\b`, "g"),
          proxyHostname
        )
      );
    }
  }
  return new Request(url.toString(), {
    method: request.method,
    headers: newRequestHeaders,
    body: request.body,
    redirect: "follow",
  });
}

function setResponseHeaders(
  originalResponse,
  proxyHostname,
  originHostname,
  DEBUG
) {
  const newResponseHeaders = new Headers(originalResponse.headers);
  for (const [key, value] of newResponseHeaders) {
    if (value.includes(proxyHostname)) {
      newResponseHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
          originHostname
        )
      );
    }
  }
  if (DEBUG) {
    newResponseHeaders.delete("content-security-policy");
  }
  let docker_auth_url = newResponseHeaders.get("www-authenticate");
  if (docker_auth_url && docker_auth_url.includes("auth.docker.io/token")) {
    newResponseHeaders.set(
      "www-authenticate",
      docker_auth_url.replace("auth.docker.io/token", originHostname + "/token")
    );
  }
  return newResponseHeaders;
}

/**
 * 替换内容
 * @param originalResponse 响应
 * @param proxyHostname 代理地址 hostname
 * @param pathnameRegex 代理地址路径匹配的正则表达式
 * @param originHostname 替换的字符串
 * @returns {Promise<*>}
 */
async function replaceResponseText(
  originalResponse,
  proxyHostname,
  pathnameRegex,
  originHostname
) {
  let text = await originalResponse.text();
  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\^/, "");
    return text.replace(
      new RegExp(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex})`, "g"),
      `${originHostname}$2`
    );
  } else {
    return text.replace(
      new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
      originHostname
    );
  }
}

async function nginx() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>保護地球 · 綠色生態</title>
<style>
html { color-scheme: light dark; }
body { 
  width: 35em; 
  margin: 0 auto;
  padding: 2em;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
}
.container {
  background: rgba(255, 255, 255, 0.95);
  color: #2d3748;
  border-radius: 15px;
  padding: 2em;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
}
h1 { 
  color: #22c55e; 
  font-size: 2em;
  margin-bottom: 0.5em;
  text-align: center;
}
.emoji { font-size: 3em; text-align: center; margin: 0.5em 0; }
p { line-height: 1.8; margin: 1em 0; }
.tips {
  background: #dcfce7;
  border-left: 4px solid #22c55e;
  padding: 1em;
  margin: 1.5em 0;
  border-radius: 5px;
}
.tips strong { color: #16a34a; }
footer {
  text-align: center;
  margin-top: 2em;
  font-size: 0.9em;
  color: #64748b;
}
</style>
</head>
<body>
<div class="container">
  <div class="emoji">🌍🌱💚</div>
  <h1>愛護地球，從我做起</h1>
  
  <p>地球是我們唯一的家園，保護環境就是保護我們自己的未來。每一個小小的行動，都能為地球帶來改變。</p>
  
  <div class="tips">
    <strong>💡 綠色生活小貼士：</strong>
    <ul>
      <li>🚶 減少碳排放：多步行、騎自行車或使用公共交通</li>
      <li>♻️ 垃圾分類：讓資源循環再利用</li>
      <li>💧 節約用水：珍惜每一滴水資源</li>
      <li>🌳 植樹造林：為地球增添綠色</li>
      <li>🛍️ 減少使用一次性塑料製品</li>
      <li>💡 節約能源：隨手關燈、使用節能電器</li>
    </ul>
  </div>
  
  <p><strong>🌏 讓我們一起行動：</strong></p>
  <p>保護環境不是一個人做了很多，而是每個人都做了一點點。讓我們攜手共建美麗家園，為子孫後代留下一個綠色的地球！</p>
  
  <footer>
    <p><em>💚 地球只有一個，請珍惜愛護 💚</em></p>
  </footer>
</div>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    try {
      let {
        PROXY_HOSTNAME = "registry-1.docker.io",
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX,
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302,
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        KEEP_PATH = false,
        DEBUG = false,
      } = env;
      const url = new URL(request.url);
      const originHostname = url.hostname;
      if (url.pathname.includes("/token")) {
        PROXY_HOSTNAME = "auth.docker.io";
      } else if (url.pathname.includes("/search")) {
        PROXY_HOSTNAME = "index.docker.io";
      }
      if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX &&
          !new RegExp(UA_WHITELIST_REGEX).test(
            request.headers.get("user-agent").toLowerCase()
          )) ||
        (UA_BLACKLIST_REGEX &&
          new RegExp(UA_BLACKLIST_REGEX).test(
            request.headers.get("user-agent").toLowerCase()
          )) ||
        (IP_WHITELIST_REGEX &&
          !new RegExp(IP_WHITELIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (IP_BLACKLIST_REGEX &&
          new RegExp(IP_BLACKLIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (REGION_WHITELIST_REGEX &&
          !new RegExp(REGION_WHITELIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          )) ||
        (REGION_BLACKLIST_REGEX &&
          new RegExp(REGION_BLACKLIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          ))
      ) {
        logError(request, "Invalid");
        return URL302
          ? Response.redirect(
              KEEP_PATH
                ? (URL302 + "/" + url.pathname).replace(/\/+/g, "/")
                : URL302,
              302
            )
          : new Response(await nginx(), {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
              },
            });
      }
      url.host = PROXY_HOSTNAME;
      url.protocol = PROXY_PROTOCOL;
      const newRequest = createNewRequest(
        request,
        url,
        PROXY_HOSTNAME,
        originHostname
      );
      const originalResponse = await fetch(newRequest);
      const newResponseHeaders = setResponseHeaders(
        originalResponse,
        PROXY_HOSTNAME,
        originHostname,
        DEBUG
      );
      const contentType = newResponseHeaders.get("content-type") || "";
      let body;
      if (contentType.includes("text/")) {
        body = await replaceResponseText(
          originalResponse,
          PROXY_HOSTNAME,
          PATHNAME_REGEX,
          originHostname
        );
      } else {
        body = originalResponse.body;
      }
      return new Response(body, {
        status: originalResponse.status,
        headers: newResponseHeaders,
      });
    } catch (error) {
      logError(request, `Fetch error: ${error.message}`);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
