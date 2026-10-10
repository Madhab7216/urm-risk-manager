import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePluginPreview, MAX_MANUAL_FX_AGE_MS } from '../plugin-policy.mjs';
import { URM_RISK_POLICY } from '../risk-core.mjs';
import { createManualEvidence } from '../evidence-integrity.mjs';

const NOW = 1_700_000_000_000;
function ev(kind, { accountKey, symbolId, value, source, ageMs = 0 } = {}) {
  const r = createManualEvidence({ kind, accountKey, symbolId, value, source, nowMs: NOW, observedAgeMs: ageMs });
  return r.ok ? r.evidence : null;
}
function makeInput(overrides = {}) {
  const currency = overrides.accountCurrency ?? 'USD';
  const accountKey = overrides.accountKey ?? `brokerx|12345|0|standard|${currency}`;
  const input = {
    accountCurrency: currency, accountCurrencyConfirmed: true,
    accountKey, symbolId: 11, nowMs: NOW,
    side: 'BUY', entry: 2000, stopLoss: 1990, pipPosition: 2,
    pipValuePerLot: 1, pipValueVerified: true, pipValueSource: 'Demo symbol specification verified',
    depositCurrencyPerUsd: currency === 'USD' ? 1 : 0.92, fxVerified: currency === 'USD',
    fxSource: 'Broker conversion view', fxAgeMs: 60_000,
    lotSizeCents: 100_000_000, minVolumeCents: 100, maxVolumeCents: 100_000_000, stepVolumeCents: 100,
    roundTurnCommissionPerLot: 7, commissionVerified: true, commissionSource: 'Broker commission schedule',
    ...overrides
  };
  if (!Object.hasOwn(overrides, 'pipValueEvidence')) input.pipValueEvidence = ev('pip-value', { accountKey:input.accountKey, symbolId:input.symbolId, value:input.pipValuePerLot, source:input.pipValueSource });
  if (input.accountCurrency !== 'USD' && !Object.hasOwn(overrides, 'fxEvidence')) input.fxEvidence = ev('fx-rate', { accountKey:input.accountKey, symbolId:null, value:input.depositCurrencyPerUsd, source:input.fxSource, ageMs:input.fxAgeMs });
  if (input.commissionVerified && !Object.hasOwn(overrides, 'commissionEvidence')) input.commissionEvidence = ev('commission', { accountKey:input.accountKey, symbolId:input.symbolId, value:input.roundTurnCommissionPerLot, source:input.commissionSource });
  return input;
}

test('Stage F preview uses fixed $10 policy, requires account/symbol-bound fresh evidence and 5R TP', () => {
  const result = calculatePluginPreview(makeInput());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.targetRiskUsd, 10);
  assert.equal(result.takeProfit, 2050);
  assert.equal(result.commissionIsIncludedInSizing, false);
  assert.equal(result.executionEnabled, false);
  assert.equal(result.manualEvidence.pipValueAgeMs, 0);
});

test('Fixed budget cannot be overridden by an extra caller field', () => {
  const result = calculatePluginPreview(makeInput({ riskUsd: 1000, riskInDepositCurrency: 1000 }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.targetRiskUsd, 10);
});

test('BUY and SELL stop validation is symmetric', () => {
  assert.equal(calculatePluginPreview(makeInput({ side:'BUY', stopLoss:2000 })).code, 'STOP_DIRECTION_INVALID');
  const sell = calculatePluginPreview(makeInput({ side:'SELL', entry:2000, stopLoss:2010 }));
  assert.equal(sell.ok, true, sell.reason);
  assert.equal(sell.takeProfit, 1950);
});

test('Unknown account currency blocks preview once exact context/evidence exist', () => {
  const input=makeInput({ accountCurrency:'UNKNOWN', accountCurrencyConfirmed:false, accountKey:'brokerx|12345|0|standard|UNKNOWN' });
  const result=calculatePluginPreview(input);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACCOUNT_CURRENCY_UNCONFIRMED');
});

test('Non-USD preview requires source, checked box, correct context and fresh FX rate', () => {
  const input=makeInput({ accountCurrency:'EUR', fxVerified:true, depositCurrencyPerUsd:0.92 });
  const pass=calculatePluginPreview(input);
  assert.equal(pass.ok,true,pass.reason);
  const noSource=calculatePluginPreview(makeInput({ ...input, fxSource:'' }));
  assert.equal(noSource.ok,false);
  assert.match(noSource.code,/FX_EVIDENCE/);
  const staleEvidence=ev('fx-rate',{accountKey:input.accountKey,symbolId:null,value:0.92,source:'Broker conversion view',ageMs:MAX_MANUAL_FX_AGE_MS+1});
  const stale=calculatePluginPreview(makeInput({ ...input, fxEvidence:staleEvidence }));
  assert.equal(stale.ok,false);
  assert.match(stale.code,/FX_EVIDENCE_EVIDENCE_STALE/);
  assert.equal(calculatePluginPreview(makeInput({ ...input, fxVerified:false })).code,'FX_NOT_VERIFIED');
});

test('Missing or changed pip evidence does not pass because the checkbox alone is not evidence', () => {
  assert.equal(calculatePluginPreview(makeInput({ pipValueVerified:false })).code,'PIP_VALUE_NOT_VERIFIED');
  assert.match(calculatePluginPreview(makeInput({ pipValueSource:'' })).code,/PIP_EVIDENCE/);
  const stale=ev('pip-value',{accountKey:'brokerx|12345|0|standard|USD',symbolId:11,value:1,source:'Demo symbol specification verified',ageMs:MAX_MANUAL_FX_AGE_MS+1});
  assert.equal(calculatePluginPreview(makeInput({pipValueEvidence:stale})).code,'PIP_EVIDENCE_EVIDENCE_STALE');
});

test('Pip evidence is invalidated by account, symbol, value or source changes', () => {
  const original=makeInput();
  assert.equal(calculatePluginPreview(original).ok,true);
  assert.equal(calculatePluginPreview(makeInput({ ...original, accountKey:'otherbroker|12345|0|standard|USD', pipValueEvidence:original.pipValueEvidence })).code,'PIP_EVIDENCE_EVIDENCE_ACCOUNT_MISMATCH');
  assert.equal(calculatePluginPreview(makeInput({ ...original, symbolId:12, pipValueEvidence:original.pipValueEvidence })).code,'PIP_EVIDENCE_EVIDENCE_SYMBOL_MISMATCH');
  assert.equal(calculatePluginPreview(makeInput({ ...original, pipValuePerLot:2, pipValueEvidence:original.pipValueEvidence })).code,'PIP_EVIDENCE_EVIDENCE_VALUE_CHANGED');
  assert.equal(calculatePluginPreview(makeInput({ ...original, pipValueSource:'different source', pipValueEvidence:original.pipValueEvidence })).code,'PIP_EVIDENCE_EVIDENCE_SOURCE_CHANGED');
});

test('Minimum-size case blocks when rounding up would exceed fixed budget', () => {
  const result=calculatePluginPreview(makeInput({pipValuePerLot:10_000_000,minVolumeCents:100,maxVolumeCents:100_000_000,stepVolumeCents:100}));
  assert.equal(result.ok,false);
  assert.equal(result.code,'BELOW_MINIMUM_VOLUME');
});

test('Commission is separate, context-bound and only estimated after fresh manual attestation', () => {
  const withCommission=calculatePluginPreview(makeInput());
  const withoutCommission=calculatePluginPreview(makeInput({commissionVerified:false}));
  assert.equal(withCommission.ok,true);
  assert.equal(withCommission.commissionIsIncludedInSizing,false);
  assert.equal(withCommission.commissionEstimate,withCommission.lots*7);
  assert.equal(withoutCommission.commissionEstimate,null);
  assert.equal(withoutCommission.commissionStatus,'NOT_VERIFIED');
  assert.equal(withCommission.volumeCents,withoutCommission.volumeCents);
  const stale=ev('commission',{accountKey:'brokerx|12345|0|standard|USD',symbolId:11,value:7,source:'Broker commission schedule',ageMs:24*60*60*1000+1});
  const staleResult=calculatePluginPreview(makeInput({commissionEvidence:stale}));
  assert.equal(staleResult.ok,true);
  assert.equal(staleResult.commissionEstimate,null);
  assert.match(staleResult.commissionStatus,/VERIFICATION_INCOMPLETE/);
});

test('Invalid commission evidence never blocks price-risk sizing and never shows a false estimate', () => {
  const result=calculatePluginPreview(makeInput({commissionVerified:true,commissionSource:'',commissionEvidence:null}));
  assert.equal(result.ok,true,result.reason);
  assert.equal(result.commissionEstimate,null);
  assert.match(result.commissionStatus,/VERIFICATION_INCOMPLETE/);
});

test('Risk ladder constants match approved policy', () => {
  assert.equal(URM_RISK_POLICY.targetRiskUsd,10);
  assert.equal(URM_RISK_POLICY.takeProfitR,5);
  assert.equal(URM_RISK_POLICY.breakEvenAtR,1);
  assert.equal(URM_RISK_POLICY.profitLockAtR,2);
  assert.equal(URM_RISK_POLICY.profitLockToR,1.7);
  assert.equal(URM_RISK_POLICY.trailingStartsAtR,3);
  assert.equal(URM_RISK_POLICY.trailingGapR,1);
});
