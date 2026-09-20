import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCsv,
  applyPlayersSheetNameMapping,
  playersSheetNameFields,
} from "./registrant-import.js";

function sheetRow(values) {
  const cells = Array.from({ length: 67 }, () => "");
  Object.entries(values).forEach(([index, value]) => {
    cells[Number(index)] = value;
  });
  return cells;
}

test("maps Players sheet name columns into registration fields", () => {
  const headers = Array.from({ length: 67 }, (_, index) => `Column ${index + 1}`);
  const cells = sheetRow({
    0: "submission-1",
    26: "Jordan",
    27: "Ligon",
    39: "Avery",
    40: "Ligon",
    52: "Blake",
    53: "Ligon",
    65: "Casey",
    66: "Ligon",
  });
  headers[0] = "Submission ID";
  const [row] = parseCsv([headers.join(","), cells.join(",")].join("\n"));

  assert.equal(row.parent_first_name, "Jordan");
  assert.equal(row.parent_last_name, "Ligon");
  assert.equal(row.player_1_first_name, "Avery");
  assert.equal(row.player_1_last_name, "Ligon");
  assert.equal(row.player_2_first_name, "Blake");
  assert.equal(row.player_2_last_name, "Ligon");
  assert.equal(row.player_3_first_name, "Casey");
  assert.equal(row.player_3_last_name, "Ligon");
  assert.equal(row.player_count, "3");
});

test("recovers fixed-column names from an existing imported payload", () => {
  const payload = {};
  const cells = sheetRow({
    26: "Jordan",
    27: "Ligon",
    39: "Avery",
    40: "Ligon",
    52: "Blake",
    53: "Ligon",
    65: "Casey",
    66: "Ligon",
  });
  cells.forEach((value, index) => { payload[`Column ${index + 1}`] = value; });
  const names = playersSheetNameFields(payload);

  assert.deepEqual(names, {
    parentFirst: "Jordan",
    parentLast: "Ligon",
    playerNames: ["Avery Ligon", "Blake Ligon", "Casey Ligon"],
    participantNames: "Avery Ligon||Blake Ligon||Casey Ligon",
  });
});

test("does not overwrite explicit normalized names", () => {
  const values = {
    parent_first_name: "Explicit Parent",
    parent_last_name: "Name",
    player_1_first_name: "Explicit Player",
    player_1_last_name: "Name",
  };
  const cells = sheetRow({ 26: "Sheet Parent", 27: "Name", 39: "Sheet Player", 40: "Name" });
  applyPlayersSheetNameMapping(values, cells);

  assert.equal(values.parent_first_name, "Explicit Parent");
  assert.equal(values.player_1_first_name, "Explicit Player");
});
