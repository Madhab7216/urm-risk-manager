import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCoreFingerprint, accountSnapshotConsistent, createAccountProfile, isAccountProfileFresh, MAX_ACCOUNT_SNAPSHOT_AGE_MS } from '../account-profile.mjs';
const trader={Login:12345,BrokerName:'Broker X',accountType:0,isLimitedRisk:false,balance:100000,moneyDigits:2};
test('fresh account profile binds broker, login, model, limited-risk flag and deposit currency',()=>{
  const r=createAccountProfile({trader,currency:'USD',nowMs:1000}); assert.equal(r.ok,true); assert.equal(r.profile.key,'broker x|12345|0|standard|USD'); assert.equal(r.support.ok,true); assert.equal(isAccountProfileFresh(r.profile,1000),true);
});
test('missing account type or limited-risk flag is not guessed',()=>{
  assert.equal(createAccountProfile({trader:{...trader,accountType:undefined},currency:'USD',nowMs:1000}).ok,false);
  assert.equal(createAccountProfile({trader:{...trader,isLimitedRisk:undefined},currency:'USD',nowMs:1000}).ok,false);
});
test('account mode and limited-risk account are blocked unless the supported mode is confirmed',()=>{
  assert.equal(createAccountProfile({trader:{...trader,accountType:1},currency:'USD',nowMs:1000}).support.code,'ACCOUNT_TYPE_UNSUPPORTED');
  assert.equal(createAccountProfile({trader:{...trader,accountType:2},currency:'USD',nowMs:1000}).support.code,'ACCOUNT_TYPE_UNSUPPORTED');
  assert.equal(createAccountProfile({trader:{...trader,isLimitedRisk:true},currency:'USD',nowMs:1000}).support.code,'LIMITED_RISK_ACCOUNT_UNSUPPORTED');
});
test('two account refresh responses can be compared to detect an account switch during load',()=>{
  assert.equal(accountCoreFingerprint(trader),accountCoreFingerprint({...trader}));
  assert.notEqual(accountCoreFingerprint(trader),accountCoreFingerprint({...trader,Login:67890}));
});
test('account snapshot ages out and future timestamp is invalid',()=>{
  const r=createAccountProfile({trader,currency:'USD',nowMs:1000});
  assert.equal(isAccountProfileFresh(r.profile,1000+MAX_ACCOUNT_SNAPSHOT_AGE_MS),true);
  assert.equal(isAccountProfileFresh(r.profile,1001+MAX_ACCOUNT_SNAPSHOT_AGE_MS),false);
  assert.equal(isAccountProfileFresh(r.profile,999),false);
});

test('account identity and currency must be stable across the two account/group snapshots',()=>{
  assert.equal(accountSnapshotConsistent({firstTrader:trader,firstCurrency:'USD',secondTrader:{...trader},secondCurrency:'USD'}),true);
  assert.equal(accountSnapshotConsistent({firstTrader:trader,firstCurrency:'USD',secondTrader:{...trader,Login:12346},secondCurrency:'USD'}),false);
  assert.equal(accountSnapshotConsistent({firstTrader:trader,firstCurrency:'USD',secondTrader:{...trader},secondCurrency:'EUR'}),false);
});
