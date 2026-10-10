import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const html=readFileSync(resolve(root,'index.html'),'utf8');
const engine=readFileSync(resolve(root,'execution-engine.mjs'),'utf8');
const policy=readFileSync(resolve(root,'plugin-policy.mjs'),'utf8');
const evidence=readFileSync(resolve(root,'evidence-integrity.mjs'),'utf8');
const broker=readFileSync(resolve(root,'broker-constraints.mjs'),'utf8');
const account=readFileSync(resolve(root,'account-profile.mjs'),'utf8');

function inlineModule() {
  const m=html.match(/<script type="module">([\s\S]*?)<\/script>/i);
  assert.ok(m,'module script must exist'); return m[1];
}

test('UI exposes fixed USD 10 and has no editable risk-amount control',()=>{
  assert.match(html,/Fixed target price risk/);
  assert.match(html,/\$10\.00 USD \/ trade/);
  assert.doesNotMatch(html,/id="riskUsd"/);
});

test('Stage F execution gate is hard-locked and recovery remains non-executable',()=>{
  assert.match(html,/executionEnabled:\s*false/);
  assert.match(html,/demoAccountConfirmed:\s*false/);
  assert.match(html,/demoValidationComplete:\s*false/);
  assert.match(html,/Order execution locked — Demo validation required/);
  assert.match(html,/persistSnapshot:\s*\(\)\s*=>\s*false/);
  assert.match(engine,/EXECUTION_LEDGER_NOT_DURABLE/);
  assert.match(html,/C# compilation plus broker-host Demo validation remain outstanding/);
});

test('UI policy display matches approved 2R/3R policy and 5R target',()=>{
  assert.match(html,/\+2R → \+1\.7R/);
  assert.match(html,/\+3R → \+2R/);
  assert.match(html,/TP = \+5R/);
  assert.doesNotMatch(html,/2\.2R/);
});

test('symbol list requires an explicit enabled===true even across SDK field casing',()=>{
  assert.match(html,/enabled:fieldValue\(s,'enabled'\)===true/);
  assert.match(html,/\.filter\(s=>Number\.isSafeInteger\(s\.id\)&&s\.id>=0&&s\.name&&s\.enabled\)/);
  assert.match(html,/const lower=key\.toLowerCase\(\)/);
});

test('freshness uses cTrader source timestamp as well as local receipt time',()=>{
  assert.match(html,/timestamp=Number\(o\.timestamp\)/);
  assert.match(html,/quoteAgeMs=state\.quote \? now-Number\(state\.quote\.timestamp\)/);
  assert.match(html,/first quote may be a market-closed snapshot/i);
});

test('account refresh cross-checks account identity before accepting currency/profile snapshot',()=>{
  assert.match(html,/const fpA=traderFingerprint\(firstTrader\), fpB=traderFingerprint\(secondTrader\)/);
  assert.match(html,/if\(!accountSnapshotConsistent\(/);
  assert.match(html,/accountTypeName/);
  assert.match(account,/MAX_ACCOUNT_SNAPSHOT_AGE_MS = 120_000/);
  assert.match(account,/function accountSnapshotConsistent/);
  assert.match(html,/getAccountGroupInformation\(state\.adapter,\{\}\)\.pipe\(take\(1\)\)\.subscribe\(\{\n                next:secondGroupResponse/);
});

test('manual evidence is bound to account, symbol, input value and source with expiry',()=>{
  assert.match(html,/captureEvidence\('pip-value'\)/);
  assert.match(html,/captureEvidence\('fx-rate'\)/);
  assert.match(html,/captureEvidence\('commission'\)/);
  assert.match(evidence,/EVIDENCE_ACCOUNT_MISMATCH/);
  assert.match(evidence,/EVIDENCE_SYMBOL_MISMATCH/);
  assert.match(evidence,/EVIDENCE_VALUE_CHANGED/);
  assert.match(evidence,/EVIDENCE_SOURCE_CHANGED/);
  assert.match(evidence,/MAX_MANUAL_PIP_VALUE_AGE_MS = 15 \* 60 \* 1000/);
  assert.match(evidence,/MAX_MANUAL_COMMISSION_AGE_MS = 24 \* 60 \* 60 \* 1000/);
});

test('broker SL/TP min-distance fields are consumed, while max-exposure and tick grid are not falsely cleared',()=>{
  assert.match(html,/slDistancePoints:state\.meta\.slDistancePoints/);
  assert.match(html,/tpDistancePoints:state\.meta\.tpDistancePoints/);
  assert.match(html,/maxExposure cannot be validated without an authoritative open-position exposure snapshot/);
  assert.match(broker,/UNVERIFIED_TICKSIZE_NOT_EXPOSED_BY_WEB_PLUGIN_PROTO_SYMBOL/);
  assert.match(html,/id="tickGridWarning"/);
});

test('commission stays separate from sizing and execution remains disabled',()=>{
  assert.match(html,/Commission estimate — kept outside the \$10 price-risk budget/);
  assert.match(policy,/commissionIsIncludedInSizing: false/);
  assert.match(html,/commission is displayed separately and excluded from volume sizing/i);
});

test('current official SDK adapter package pattern is used',()=>{
  assert.match(html,/@spotware-web-team\/sdk-external-api/);
  assert.match(html,/@spotware-web-team\/sdk/);
});

test('inline Web Plugin module has valid JavaScript syntax',()=>{
  execFileSync(process.execPath,['--check','--input-type=module'],{input:inlineModule(),stdio:['pipe','pipe','pipe']});
});


test('pip-value and commission freshness follows declared source observation age, not only checkbox time',()=>{
  assert.match(html,/id="pipAgeMinutes"/);
  assert.match(html,/observedAgeMs:num\('pipAgeMinutes'\)\*60000/);
  assert.match(html,/id="commissionAgeHours"/);
  assert.match(html,/observedAgeMs:num\('commissionAgeHours'\)\*60\*60\*1000/);
  assert.match(html,/MAX_MANUAL_PIP_VALUE_AGE_MS/);
  assert.match(html,/MAX_MANUAL_COMMISSION_AGE_MS/);
});

test('account refresh errors invalidate all prior account-scoped display and evidence',()=>{
  assert.match(html,/Account currency consistency recheck failed; previous account display and manual evidence cleared, preview blocked/);
  assert.match(html,/function invalidateAccountSnapshot\(message, details=\{\}\)\s*\{\s*state\.accountProfile=null; state\.balance=null; state\.equity=null; state\.currency='UNKNOWN';/);
  assert.match(html,/function pickBalanceEquity\(result\)\s*\{\s*\/\/ Clear first[\s\S]*?state\.balance=null; state\.equity=null;/);
});


test('explicitly disabled account group blocks preview and stale identity values are not retained',()=>{
  assert.match(html,/accountGroupExplicitlyDisabled\(groupResponse\)/);
  assert.match(html,/accountGroupExplicitlyDisabled\(secondGroupResponse\)/);
  assert.match(html,/Number\(state\.meta\.pipPosition\)<=Number\(state\.meta\.digits\)/);
  assert.match(html,/Account context is consistent across two SDK reads[\s\S]*?not an atomic snapshot/);
});


test('cTrader light/dark theme query parameter maps to explicit accessible palettes',()=>{
  assert.match(html,/<meta name="color-scheme" content="light dark">/);
  assert.match(html,/new URLSearchParams\(window\.location\.search\)\.get\('theme'\)/);
  assert.match(html,/requestedTheme === 'light' \? 'light' : 'dark'/);
  assert.match(html,/:root\[data-theme="light"\]/);
  assert.match(html,/--bg:#f3f6fb/);
  assert.match(html,/--bg:#0b1220/);
  assert.match(html,/@media\(max-width:620px\)/);
});

test('Stage G order submission remains locked after theme changes',()=>{
  assert.match(html,/executionEnabled:\s*false/);
  assert.match(html,/demoValidationComplete:\s*false/);
  assert.match(html,/Order execution locked — Demo validation required/);
});


test('does not retain the legacy dark stylesheet override after theme variables',()=>{
  assert.equal((html.match(/\.card h2\{/g)||[]).length,1,'card heading rule must not be duplicated');
  assert.equal((html.match(/\.metric\{/g)||[]).length,1,'metric background rule must not be duplicated');
  assert.equal((html.match(/input,select\{/g)||[]).length,1,'input theme rule must not be duplicated');
  assert.doesNotMatch(html, /\.card h2\{[^}]*color:#cfe2ff/);
  assert.doesNotMatch(html, /\.metric\{[^}]*background:#0b1424/);
  assert.doesNotMatch(html, /input,select\{[^}]*background:#0b1424/);
});


test('adds privacy-safe cTrader SDK response diagnostics for account and symbol parsing',()=>{
  assert.match(html,/function accountResponseShape\(response\)/);
  assert.match(html,/function accountGroupResponseShape\(response\)/);
  assert.match(html,/function symbolListResponseShape\(response\)/);
  assert.match(html,/sdkResponse:'getAccountInformation:first'/);
  assert.match(html,/sdkResponse:'getAccountGroupInformation:first'/);
  assert.match(html,/sdkResponse:'getLightSymbolList'/);
  assert.match(html,/Diagnostic summaries deliberately log field names and counts only/);
  assert.match(html,/executionEnabled:\s*false/);
});


test('cTrader account and group parsing accepts camelCase and PascalCase SDK fields',()=>{
  assert.match(html,/function fieldValue\(object, \.\.\.aliases\)/);
  assert.match(html,/fieldValue\(o,'Login'\)/);
  assert.match(html,/fieldValue\(raw,'BrokerName','brokerName'\)/);
  assert.match(html,/fieldValue\(raw,'isLimitedRisk'\)/);
  assert.match(html,/function findDepositCurrency\(result\)/);
  assert.match(html,/fieldValue\(x,'depositCurrency'\)/);
  assert.match(html,/function responsePayloadInfo\(response\)/);
  assert.match(html,/envelopePayloadKeys/);
});

test('symbol metadata accepts case variants but never guesses missing enabled state',()=>{
  assert.match(html,/fieldValue\(s,'id','symbolId'\)/);
  assert.match(html,/fieldValue\(s,'name','symbolName'\)/);
  assert.match(html,/enabled:fieldValue\(s,'enabled'\)===true/);
  assert.match(html,/enabled:enabled===true/);
  assert.match(html,/executionEnabled:\s*false/);
});


test('quick diagnostics summary is concise while raw SDK logs are collapsed',()=>{
  assert.match(html,/<h2>Quick diagnostics summary<\/h2>/);
  assert.match(html,/id="diagHost"/);
  assert.match(html,/id="diagAccount"/);
  assert.match(html,/id="diagSymbols"/);
  assert.match(html,/id="diagMeta"/);
  assert.match(html,/id="diagQuote"/);
  assert.match(html,/id="diagTickGrid"/);
  assert.match(html,/<details class="card diag-raw">/);
  assert.match(html,/<summary>Advanced raw SDK logs \(technical details\)<\/summary>/);
  assert.match(html,/if\(detail\.length>1400\) detail=detail\.slice\(0,1397\)\+'\.\.\.'/);
  assert.match(html,/executionEnabled:\s*false/);
});
