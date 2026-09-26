#!/usr/bin/env node
'use strict';
const fs=require('node:fs'); const path=require('node:path');
const root=path.resolve(__dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const debt=JSON.parse(fs.readFileSync(path.join(root,'COVERAGE_DEBT.json'),'utf8'));
const threshold=pkg.jest?.coverageThreshold || {};
const global=threshold.global || {};
if (JSON.stringify(global)!==JSON.stringify(debt.globalFloor)) throw new Error('coverage global floor drift');
const actual=Object.fromEntries(Object.entries(threshold).filter(([k])=>k!=='global'));
const listed=debt.exceptions || {};
const aKeys=Object.keys(actual).sort(), dKeys=Object.keys(listed).sort();
if (JSON.stringify(aKeys)!==JSON.stringify(dKeys)) throw new Error(`coverage debt inventory drift: actual=${aKeys.length}, listed=${dKeys.length}`);
// ── BU DONGU BIR SEY OLCMUYORDU ──────────────────────────────────────────────
// `target` hesaplaniyor ama HIC kullanilmiyordu (lint: "assigned a value but
// never used"). Geriye kalan tek kontrol `cur < 0` idi ve bu makul hicbir
// esikte tetiklenemez. Yani `targetFloor` alani ve `belowGlobal` bayragi
// defterde duruyordu ama HICBIR SEY onlari dogrulamiyordu: biri per-file
// esigi kuresel tabanin ALTINA indirip `belowGlobal: false` birakabilir ve
// envanter sessizce YALAN soylerdi — oysa bu dosyanin tek isi envanterin
// dogru olmasini garanti etmek.
for (const key of aKeys) {
  const current=actual[key], item=listed[key];
  if (JSON.stringify(current)!==JSON.stringify(item.currentFloor)) throw new Error(`coverage floor drift for ${key}`);
  let anyBelowTarget=false;
  for (const metric of ['statements','lines','functions','branches']) {
    const target=item.targetFloor?.[metric] ?? global[metric];
    const cur=current[metric];
    if (typeof cur!=='number') continue;
    if (cur < 0) throw new Error(`invalid negative coverage floor for ${key}:${metric}`);
    if (typeof target==='number' && cur < target) anyBelowTarget=true;
  }
  // Bayrak GERCEGI yansitmali: bir metrik hedefin altindaysa borc "kuresel
  // tabanin altinda" olarak isaretlenmis OLMALI; degilse isaretlenmemeli.
  if (Boolean(item.belowGlobal) !== anyBelowTarget) {
    throw new Error(
      `coverage debt inventory lies for ${key}: belowGlobal=${Boolean(item.belowGlobal)} `
      + `but measured below-target=${anyBelowTarget}`);
  }
}
const below=aKeys.filter((k)=>listed[k].belowGlobal).length;
console.log(`✅ Coverage policy PASS: global ${global.lines}% floor for non-overridden coverage; ${below} below-global per-file debts explicitly inventoried (${aKeys.length} overrides total)`);
