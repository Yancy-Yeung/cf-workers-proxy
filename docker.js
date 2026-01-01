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
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>지구 보호 · 녹색 생태</title>
<style>
html { color-scheme: light dark; }
body { 
  width: 35em; 
  margin: 0 auto;
  padding: 2em;
  font-family: 'Malgun Gothic', 'Apple Gothic', sans-serif;
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
  <h1>지구를 사랑하자, 나부터 시작하자</h1>
  
  <p>지구는 우리가 유일한 고향입니다. 환경을 보호하는 것은 우리 자신의 미래를 보호하는 것입니다. 작은 행동 하나하나가 지구에 변화를 가져올 수 있습니다.</p>
  
  <div class="tips">
    <strong>💡 녹색 생활 팁:</strong>
    <ul>
      <li>🚶 탄소 배출 감소: 도보, 자전거 또는 대중교통 이용</li>
      <li>♻️ 쓰레기 분류: 자원을 재활용</li>
      <li>💧 물 절약: 물 한 방울을 아끼자</li>
      <li>🌳 나무 심기: 지구에 녹색을 더하자</li>
      <li>🛍️ 일회용 플라스틱 제품 사용 감소</li>
      <li>💡 에너지 절약: 불 끄기, 에너지 절약 전기제품 사용</li>
    </ul>
  </div>
  
  <p><strong>🌏 함께 행동하자:</strong></p>
  <p>환경 보호는 한 사람이 많이 하는 것이 아니라, 각자가 조금씩 하는 것입니다. 함께 아름다운 고향을 만들어 후손들에게 녹색 지구를 남겨주자!</p>
  
  <footer>
    <p><em>💚 지구는 하나뿐입니다, 아끼고 사랑하세요 💚</em></p>
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
