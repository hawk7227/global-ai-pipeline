import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeCandidateId, candidateChangedFiles } from '../workspace-guard';

let pass=0, fail=0;
const t=(n:string,c:boolean)=>{c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n));};

function repo(){
  const d=mkdtempSync(join(tmpdir(),'cand-'));
  execSync('git init -q && git config user.email a@b.c && git config user.name t',{cwd:d});
  writeFileSync(join(d,'tracked.ts'),'export const a=1;\n');
  execSync('git add -A && git commit -q -m base',{cwd:d});
  return {dir:d, sha:execSync('git rev-parse HEAD',{cwd:d,encoding:'utf8'}).trim()};
}

console.log('\n=== THE BUG: untracked file, same name, different contents ===');
const r1=repo(); writeFileSync(join(r1.dir,'new-file.ts'),'export const CONTENT="A";\n');
const idA=computeCandidateId(r1.dir,r1.sha);
writeFileSync(join(r1.dir,'new-file.ts'),'export const CONTENT="B";\n');
const idB=computeCandidateId(r1.dir,r1.sha);
console.log(`   content A -> ${idA}`);
console.log(`   content B -> ${idB}`);
t('DIFFERENT contents produce DIFFERENT candidateId', idA!==idB);

console.log('\n=== stability: same exact candidate -> same id ===');
writeFileSync(join(r1.dir,'new-file.ts'),'export const CONTENT="A";\n');
t('recomputed id matches original', computeCandidateId(r1.dir,r1.sha)===idA);
t('repeated computation is stable', computeCandidateId(r1.dir,r1.sha)===computeCandidateId(r1.dir,r1.sha));

console.log('\n=== tracked modifications still change identity ===');
const clean=computeCandidateId(r1.dir,r1.sha);
writeFileSync(join(r1.dir,'tracked.ts'),'export const a=2;\n');
t('tracked edit changes id', computeCandidateId(r1.dir,r1.sha)!==clean);

console.log('\n=== a renamed untracked file changes identity ===');
const r2=repo(); writeFileSync(join(r2.dir,'x.ts'),'same bytes\n');
const nameX=computeCandidateId(r2.dir,r2.sha);
rmSync(join(r2.dir,'x.ts')); writeFileSync(join(r2.dir,'y.ts'),'same bytes\n');
t('same bytes under a different path -> different id', computeCandidateId(r2.dir,r2.sha)!==nameX);

console.log('\n=== two independent repos, identical candidate content ===');
const r3=repo(); const r4=repo();
writeFileSync(join(r3.dir,'n.ts'),'X\n'); writeFileSync(join(r4.dir,'n.ts'),'X\n');
t('identity is content-derived (differs only by checkpoint sha)',
  (r3.sha===r4.sha) === (computeCandidateId(r3.dir,r3.sha)===computeCandidateId(r4.dir,r4.sha)));

console.log('\n=== clean tree has a stable baseline identity ===');
const r5=repo();
const cleanId=computeCandidateId(r5.dir,r5.sha);
t('clean tree id stable', cleanId===computeCandidateId(r5.dir,r5.sha));
writeFileSync(join(r5.dir,'z.ts'),'z\n');
t('adding an untracked file changes it', computeCandidateId(r5.dir,r5.sha)!==cleanId);

console.log('\n=== changed-file list includes untracked ===');
const files=candidateChangedFiles(r5.dir);
t('untracked file listed', files.includes('z.ts'));
t('list is sorted', JSON.stringify(files)===JSON.stringify([...files].sort()));

for (const d of [r1,r2,r3,r4,r5]) rmSync(d.dir,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
