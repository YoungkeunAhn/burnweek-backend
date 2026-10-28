/**
 * 토스 파트너 API mTLS 연결 확인. 콘솔 설정을 바꾼 뒤 "지금 되나?"를 1초에 답한다.
 *
 *   node scripts/probe-toss-mtls.cjs
 *
 * authorizationCode 는 일부러 무효값을 보낸다 — 유효한 코드는 실제 사용자가
 * 미니앱에서 로그인해야만 나온다. 우리가 알고 싶은 건 **TLS 가 뚫리는지**이고,
 * 토스가 애플리케이션 에러(FAIL)를 돌려주면 그 자체가 인증서가 통했다는 증거다.
 *
 * 인증서 경로는 기본이 backend/secrets/ 의 콘솔 발급 파일이고 env 로 바꿀 수 있다.
 * 두 파일 모두 .gitignore 대상이다 — 개인키는 절대 커밋하지 않는다.
 */
const fs = require("fs");
const path = require("path");
const { exchangeCode } = require("../lib/auth/toss.js");

const SECRETS = path.resolve(__dirname, "../secrets");
const certPath = process.env.TOSS_CERT_PATH || path.join(SECRETS, "burnweek_public.crt");
const keyPath = process.env.TOSS_KEY_PATH || path.join(SECRETS, "burnweek_private.key");

for (const p of [certPath, keyPath]) {
  if (!fs.existsSync(p)) {
    console.error(`인증서 파일이 없습니다: ${p}\n콘솔에서 발급받아 두거나 TOSS_CERT_PATH/TOSS_KEY_PATH 를 지정하세요.`);
    process.exit(2);
  }
}

(async () => {
  const cfg = {
    clientCert: fs.readFileSync(certPath, "utf8"),
    clientKey: fs.readFileSync(keyPath, "utf8"),
  };
  try {
    await exchangeCode(cfg, "invalid-code-connectivity-probe", "DEFAULT");
    console.log("예상 밖: 무효 코드로 토큰이 발급됐습니다. 응답 규격을 다시 확인하세요.");
  } catch (err) {
    const m = err.message;
    console.log(`응답: ${m}\n`);
    if (/^generate-token: (HTTP \d+|\S+)/.test(m) && !/certificate|SSL|TLS|handshake|ECONNRESET|EPROTO|ENOTFOUND/i.test(m)) {
      console.log("PASS — mTLS 성공. 토스가 우리 인증서를 받아들이고 애플리케이션 응답을 돌려줬습니다.");
      if (/4050|등록된 미니앱이 아닙니다/.test(m)) {
        console.log("      다만 이 미니앱이 인증서버에 없습니다 → 콘솔에서 **간편 로그인 기능**을 활성화하세요.");
      }
      process.exit(0);
    }
    console.log("FAIL — TLS 단계에서 막혔습니다. 인증서·키 쌍과 만료일을 확인하세요:");
    console.log("      openssl x509 -in <crt> -noout -dates");
    process.exit(1);
  }
})();
