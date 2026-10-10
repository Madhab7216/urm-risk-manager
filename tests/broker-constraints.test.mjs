import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBrokerConstraints, classifyTickGrid } from '../broker-constraints.mjs';
const base={side:'BUY',bid:1999.9,ask:2000.0,stopLoss:1990,takeProfit:2050,digits:2,symbolEnabled:true,slDistancePoints:5,tpDistancePoints:5,maxExposureUsdCents:500000};
test('broker minimum distance check uses close-side quote and documented point unit',()=>{
  const r=evaluateBrokerConstraints(base); assert.equal(r.ok,true,r.reason); assert.equal(r.pointSize,0.01); assert.equal(r.minSL,0.05); assert.equal(r.minTP,0.05); assert.equal(r.tickGridStatus,'UNVERIFIED_TICKSIZE_NOT_EXPOSED_BY_WEB_PLUGIN_PROTO_SYMBOL'); assert.equal(r.exposureStatus,'EXPOSURE_CAP_UNCHECKED_POSITION_LIST_UNAVAILABLE'); assert.equal(r.executionEnabled,false);
});
test('SELL checks are mirrored against Ask',()=>{
  const r=evaluateBrokerConstraints({...base,side:'SELL',bid:1999.9,ask:2000,stopLoss:2010,takeProfit:1950}); assert.equal(r.ok,true,r.reason); assert.equal(r.closeSidePrice,2000);
});
test('missing SL/TP distance data does not pass',()=>{
  assert.equal(evaluateBrokerConstraints({...base,tpDistancePoints:null}).code,'BROKER_MIN_DISTANCE_UNVERIFIED');
  assert.equal(evaluateBrokerConstraints({...base,slDistancePoints:undefined}).code,'BROKER_MIN_DISTANCE_UNVERIFIED');
});
test('wrong-side protection and distance shorter than broker minimum are rejected',()=>{
  assert.equal(evaluateBrokerConstraints({...base,stopLoss:2000}).code,'BROKER_SL_WRONG_SIDE');
  assert.equal(evaluateBrokerConstraints({...base,takeProfit:1999}).code,'BROKER_TP_WRONG_SIDE');
  assert.equal(evaluateBrokerConstraints({...base,stopLoss:1999.86}).code,'BROKER_SL_DISTANCE_TOO_SMALL');
  assert.equal(evaluateBrokerConstraints({...base,takeProfit:1999.94}).code,'BROKER_TP_DISTANCE_TOO_SMALL');
});
test('disabled or unverified symbols fail closed',()=>{
  assert.equal(evaluateBrokerConstraints({...base,symbolEnabled:false}).code,'SYMBOL_NOT_CONFIRMED_ENABLED');
  assert.equal(evaluateBrokerConstraints({...base,symbolEnabled:undefined}).code,'SYMBOL_NOT_CONFIRMED_ENABLED');
});
test('TickSize evidence helper rejects missing, unchecked and stale values',()=>{
  assert.equal(classifyTickGrid({tickSize:null}).code,'TICK_SIZE_MISSING');
  assert.equal(classifyTickGrid({tickSize:0.01,source:'Algo Symbol.TickSize',verified:false,verifiedAtMs:100,nowMs:200}).code,'TICK_SIZE_UNVERIFIED');
  assert.equal(classifyTickGrid({tickSize:0.01,source:'Algo Symbol.TickSize',verified:true,verifiedAtMs:100,nowMs:86_400_200}).code,'TICK_SIZE_VERIFICATION_STALE');
  assert.equal(classifyTickGrid({tickSize:0.01,source:'Algo Symbol.TickSize',verified:true,verifiedAtMs:1000,nowMs:2000}).ok,true);
});
