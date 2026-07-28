import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parseOpenCodeUsage } from "./parse_usage.ts";

// ---------- helper: build a minimal HTML wrapper ----------
function wrap(data: string): string {
  return `<!DOCTYPE html><html><head></head><body>
    <script>self.$R=self.$R||[];_$HY.r["lite.subscription.get[\\"wrk_test\\"]"]=$R[0]=$R[2]($R[1]={p:0,s:0,f:0});$R[28]($R[1],${data});</script>
    <span>15%</span><span>6%</span><span>3%</span>
  </body></html>`;
}

// ---------- tests ----------

Deno.test("standard format from HAR", () => {
  const obj = `$R[35]={mine:!0,useBalance:!1,` +
    `region:$R[36]=["us","eu","sg"],` +
    `rollingUsage:$R[37]={status:"ok",resetInSec:14945,usagePercent:15},` +
    `weeklyUsage:$R[38]={status:"ok",resetInSec:463961,usagePercent:6},` +
    `monthlyUsage:$R[39]={status:"ok",resetInSec:2646012,usagePercent:3}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 15);
  assertEquals(r.rollingUsage.resetInSec, 14945);
  assertEquals(r.weeklyUsage.usagePercent, 6);
  assertEquals(r.weeklyUsage.resetInSec, 463961);
  assertEquals(r.monthlyUsage.usagePercent, 3);
  assertEquals(r.monthlyUsage.resetInSec, 2646012);
});

Deno.test("swapped field order — usagePercent before resetInSec", () => {
  const obj = `$R[35]={mine:!0,` +
    `rollingUsage:$R[37]={status:"ok",usagePercent:42,resetInSec:7200}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 42);
  assertEquals(r.rollingUsage.resetInSec, 7200);
});

Deno.test("zero percent", () => {
  const obj = `$R[35]={` +
    `rollingUsage:$R[0]={status:"ok",resetInSec:3600,usagePercent:0}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 0);
  assertEquals(r.rollingUsage.resetInSec, 3600);
});

Deno.test("100 percent + large reset", () => {
  const obj = `$R[35]={` +
    `rollingUsage:$R[0]={status:"ok",resetInSec:999999,usagePercent:100}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 100);
  assertEquals(r.rollingUsage.resetInSec, 999999);
});

Deno.test("all three correctly isolated — monthly picks its own value", () => {
  // monthly=3, NOT rolling's 15 or weekly's 6
  const obj = `$R[35]={` +
    `rollingUsage:$R[37]={status:"ok",resetInSec:10,usagePercent:15},` +
    `weeklyUsage:$R[38]={status:"ok",resetInSec:20,usagePercent:6},` +
    `monthlyUsage:$R[39]={status:"ok",resetInSec:30,usagePercent:3}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 15);
  assertEquals(r.weeklyUsage.usagePercent, 6);
  assertEquals(r.monthlyUsage.usagePercent, 3); // not 15 or 6
  assertEquals(r.monthlyUsage.resetInSec, 30); // not 10 or 20
});

Deno.test("missing fields fall back to 0", () => {
  const obj = `$R[35]={` +
    `rollingUsage:$R[0]={status:"ok"}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 0);
  assertEquals(r.rollingUsage.resetInSec, 0);
});

Deno.test("status not ok still parses correctly", () => {
  const obj = `$R[35]={` +
    `rollingUsage:$R[0]={status:"error",resetInSec:0,usagePercent:0}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 0);
});

Deno.test("different $R index numbers", () => {
  const obj = `$R[999]={` +
    `rollingUsage:$R[12345]={status:"ok",resetInSec:5000,usagePercent:77}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 77);
  assertEquals(r.rollingUsage.resetInSec, 5000);
});

Deno.test("single-digit and double-digit mix do not cross-match", () => {
  const obj = `$R[35]={` +
    `rollingUsage:$R[1]={status:"ok",resetInSec:1,usagePercent:2},` +
    `weeklyUsage:$R[2]={status:"ok",resetInSec:33,usagePercent:44},` +
    `monthlyUsage:$R[3]={status:"ok",resetInSec:555,usagePercent:6}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 2);
  assertEquals(r.weeklyUsage.usagePercent, 44);
  assertEquals(r.monthlyUsage.usagePercent, 6);
  assertEquals(r.weeklyUsage.resetInSec, 33);
});

Deno.test("no extra fields leak between windows", () => {
  const obj = `$R[35]={` +
    `rollingUsage:$R[1]={status:"ok",usagePercent:10,resetInSec:100},` +
    `weeklyUsage:$R[2]={status:"ok",extraField:"ignore",usagePercent:20,resetInSec:200},` +
    `monthlyUsage:$R[3]={status:"ok",resetInSec:300,anotherField:999,usagePercent:30}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 10);
  assertEquals(r.weeklyUsage.usagePercent, 20);
  assertEquals(r.monthlyUsage.usagePercent, 30);
  assertEquals(r.monthlyUsage.resetInSec, 300);
});

Deno.test("throws when lite.subscription.get is missing", () => {
  // No subscription data key in the HTML
  assertThrows(
    () => parseOpenCodeUsage("<html>no data here</html>"),
    Error,
    "no Go subscription found",
  );
});

Deno.test("full HTML does not confuse with rendered percent spans", () => {
  // The rendered HTML has <span>15%</span> etc. — regex must not
  // match those. Since our parser only looks inside the object body
  // bounded by { }, rendered spans won't interfere.
  const obj = `$R[35]={` +
    `rollingUsage:$R[37]={status:"ok",resetInSec:14945,usagePercent:15},` +
    `weeklyUsage:$R[38]={status:"ok",resetInSec:463961,usagePercent:6},` +
    `monthlyUsage:$R[39]={status:"ok",resetInSec:2646012,usagePercent:3}}`;

  // Include lite.subscription.get so the sanity check passes
  const html = `<!DOCTYPE html><html>
    <head><title>opencode</title></head>
    <body>
      <span data-slot="usage-value">13%</span>
      <div>usagePercent:999</div>
      <script>self.$R=self.$R||[];_$HY.r["lite.subscription.get[\\"wrk_test\\"]"]=$R[0]=$R[2]($R[1]={p:0,s:0,f:0});$R[28]($R[1],${obj});</script>
      <span>Monthly Usage 2%</span>
    </body></html>`;

  const r = parseOpenCodeUsage(html);

  assertEquals(r.monthlyUsage.usagePercent, 3); // not 999 or 2
});

Deno.test("multiline HTML does not break matching", () => {
  const data = `rollingUsage:$R[37]={status:"ok",\nresetInSec:14945,\nusagePercent:15}`;
  const obj = `$R[35]={mine:!0,\n${data}}`;

  const r = parseOpenCodeUsage(wrap(obj));

  assertEquals(r.rollingUsage.usagePercent, 15);
  assertEquals(r.rollingUsage.resetInSec, 14945);
});
