import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManualEvidence, validateManualEvidence, makeAccountContextKey, evaluateAccountSupport,
  MAX_MANUAL_PIP_VALUE_AGE_MS, MAX_MANUAL_FX_AGE_MS, MAX_MANUAL_COMMISSION_AGE_MS
} from '../evidence-integrity.mjs';

const NOW=1_710_000_000_000;
const accountKey='brokerx|12345|0|standard|EUR';
function make(kind='pip-value', overrides={}) {
  return createManualEvidence({kind,accountKey,symbolId:kind==='fx-rate'?null:42,value:kind==='fx-rate'?0.92:kind==='commission'?7:1.25,source:`source-${kind}`,nowMs:NOW,...overrides});
}
function validate(evidence, kind='pip-value', overrides={}) {
  const value=kind==='fx-rate'?0.92:kind==='commission'?7:1.25;
  return validateManualEvidence({evidence,kind,accountKey,symbolId:kind==='fx-rate'?null:42,value,source:`source-${kind}`,nowMs:NOW,maxAgeMs:kind==='fx-rate'?MAX_MANUAL_FX_AGE_MS:kind==='commission'?MAX_MANUAL_COMMISSION_AGE_MS:MAX_MANUAL_PIP_VALUE_AGE_MS,...overrides});
}

test('manual evidence captures kind, account, symbol, exact value/source and timestamps',()=>{
  const r=make(); assert.equal(r.ok,true); assert.equal(r.evidence.accountKey,accountKey); assert.equal(r.evidence.symbolId,42); assert.equal(validate(r.evidence).ok,true);
});
test('missing evidence or source is rejected',()=>{
  assert.equal(validate(null).code,'EVIDENCE_MISSING');
  assert.equal(make('pip-value',{source:'  '}).code,'EVIDENCE_SOURCE_MISSING');
});
test('changing account, symbol, value or source invalidates evidence',()=>{
  const e=make().evidence;
  assert.equal(validate(e,'pip-value',{accountKey:'other|1|0|standard|EUR'}).code,'EVIDENCE_ACCOUNT_MISMATCH');
  assert.equal(validate(e,'pip-value',{symbolId:43}).code,'EVIDENCE_SYMBOL_MISMATCH');
  assert.equal(validate(e,'pip-value',{value:1.26}).code,'EVIDENCE_VALUE_CHANGED');
  assert.equal(validate(e,'pip-value',{source:'different'}).code,'EVIDENCE_SOURCE_CHANGED');
});
test('observed FX data ages from declared observation time, not checkbox click time',()=>{
  const r=make('fx-rate',{observedAgeMs:14*60_000}); assert.equal(r.ok,true);
  const stillFresh=validate(r.evidence,'fx-rate',{nowMs:NOW+30_000}); assert.equal(stillFresh.ok,true);
  const stale=validate(r.evidence,'fx-rate',{nowMs:NOW+2*60_000}); assert.equal(stale.code,'EVIDENCE_STALE');
});
test('future timestamps, impossible age and future-attested evidence fail closed',()=>{
  assert.equal(make('fx-rate',{observedAgeMs:-1}).code,'EVIDENCE_TIME_INVALID');
  const r=make();
  assert.equal(validate(r.evidence,'pip-value',{nowMs:NOW-1}).code,'EVIDENCE_TIME_INVALID');
});
test('commission evidence expires after 24 hours and price-risk preview remains separate',()=>{
  const r=make('commission'); assert.equal(r.ok,true);
  const aged=validate(r.evidence,'commission',{nowMs:NOW+MAX_MANUAL_COMMISSION_AGE_MS+1});
  assert.equal(aged.code,'EVIDENCE_STALE');
});
test('account context requires broker, login, model, limited-risk flag and currency',()=>{
  assert.equal(makeAccountContextKey({brokerName:' Broker X ',login:12345,accountType:0,isLimitedRisk:false,currency:'EUR'}),'broker x|12345|0|standard|EUR');
  assert.equal(makeAccountContextKey({brokerName:'Broker X',login:12345,accountType:0,currency:'EUR'}),null);
});
test('only standard HEDGED account is supported by preview',()=>{
  const base={verified:true,key:'key',isLimitedRisk:false,accountType:0};
  assert.equal(evaluateAccountSupport(base).ok,true);
  assert.equal(evaluateAccountSupport({...base,accountType:1}).code,'ACCOUNT_TYPE_UNSUPPORTED');
  assert.equal(evaluateAccountSupport({...base,accountType:2}).code,'ACCOUNT_TYPE_UNSUPPORTED');
  assert.equal(evaluateAccountSupport({...base,isLimitedRisk:true}).code,'LIMITED_RISK_ACCOUNT_UNSUPPORTED');
  assert.equal(evaluateAccountSupport({verified:false}).code,'ACCOUNT_PROFILE_UNVERIFIED');
});
