const assert = require("node:assert/strict");
const { normalizePhoneE164, partnerMatchesPhone } = require("./index");

for (const phone of ["603509208", "+34603509208", "0034603509208", "+34 603 509 208"]) {
  assert.equal(normalizePhoneE164(phone), "+34603509208");
}
assert.equal(normalizePhoneE164("+33 6 12 34 56 78"), "+33612345678");
assert.equal(normalizePhoneE164(""), null);
assert.equal(partnerMatchesPhone({ phone: "+34 603 509 208", mobile: false }, "+34603509208"), true);
assert.equal(partnerMatchesPhone({ phone: "0034603509208" }, "+34603509208"), true);
assert.equal(partnerMatchesPhone({ phone: "+34600000000", mobile: false }, "+34603509208"), false);

console.log("Phone normalization tests passed");


const synthetic = { id: 10, name: "Llamada saliente (647436423)", phone: "647436423", mobile: false, email: false };
const real = { id: 11, name: "Miguel Pacheco", phone: "+34647436423", mobile: false, email: "info@delbox.es" };
const picked = require("./index").pickCanonicalPhoneMatch([synthetic, real]);
assert.equal(picked.partner.id, 11);
assert.deepEqual(picked.syntheticPartners.map(p => p.id), [10]);
assert.equal(require("./index").isSyntheticZadarmaPartner(synthetic), true);
assert.equal(require("./index").isSyntheticZadarmaPartner(real), false);
