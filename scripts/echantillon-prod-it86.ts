import { questionStratifiee, N_TOTAL_MILLIARD, planifierBalayage } from "../lib/gen3/interrogation-milliard";

const N = N_TOTAL_MILLIARD;
const plan = planifierBalayage(N);
let acc = 0;
for (const [famille, nf] of Object.entries(plan)) {
  const q = questionStratifiee(acc, N);
  console.log(`=== ${famille} (j=${acc})`);
  console.log(`Q: ${q.prompt}`);
  console.log(`R: ${q.reponse}`);
  acc += nf;
}
