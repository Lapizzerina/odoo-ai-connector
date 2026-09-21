const assert = require("node:assert/strict");
const { normalizePhoneE164, partnerMatchesPhone } = require("./index");

for (const phone of ["603509208", "+34603509208", "0034603509208", "+34 603 509 208"]) {
  assert.equal(normalizePhoneE164(phone), "+34603509208");
}
assert.equal(normalizePhoneE164("+33 6 12 34 56 78"), "+33612345678");
assert.equal(normalizePhoneE164(""), null);
assert.equal(partnerMatchesPhone({ phone: "+34 603 509 208", mobile: false }, "+34603509208"), true);
assert.equal(partnerMatchesPhone({ phone: false, mobile: "0034603509208" }, "+34603509208"), true);
assert.equal(partnerMatchesPhone({ phone: "+34600000000", mobile: false }, "+34603509208"), false);

console.log("Phone normalization tests passed");
