'use strict';

const WORKGROUP = process.env.ATHENA_WORKGROUP || 'traffic';
const POLL_DEADLINE_MS = 25000;

let athenaClient;
function client() {
  if (!athenaClient) {
    const { AthenaClient } = require('@aws-sdk/client-athena');
    athenaClient = new AthenaClient({});
  }
  return athenaClient;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toObjects(resultSet, skipHeader) {
  const columns = resultSet.ResultSetMetadata.ColumnInfo.map((column) => column.Name);
  const rows = resultSet.Rows || [];
  return rows.slice(skipHeader ? 1 : 0).map((row) => {
    const object = {};
    columns.forEach((name, index) => {
      const cell = row.Data[index];
      object[name] = cell && cell.VarCharValue !== undefined ? cell.VarCharValue : null;
    });
    return object;
  });
}

async function runQuery(sql, { athena = client(), maxRows = 1000, wait = sleep } = {}) {
  const {
    StartQueryExecutionCommand,
    GetQueryExecutionCommand,
    GetQueryResultsCommand,
  } = require('@aws-sdk/client-athena');

  const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: WORKGROUP,
    ResultReuseConfiguration: { ResultReuseByAgeConfiguration: { Enabled: true, MaxAgeInMinutes: 5 } },
  }));

  const started = Date.now();
  let delay = 200;
  for (;;) {
    const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));
    const state = QueryExecution.Status.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena query ${state.toLowerCase()}: ${QueryExecution.Status.StateChangeReason || 'unknown reason'}`);
    }
    if (Date.now() - started > POLL_DEADLINE_MS) throw new Error('Athena query timed out');
    await wait(delay);
    delay = Math.min(delay * 1.5, 1000);
  }

  const rows = [];
  let NextToken;
  let first = true;
  do {
    const page = await athena.send(new GetQueryResultsCommand({ QueryExecutionId, NextToken, MaxResults: 1000 }));
    rows.push(...toObjects(page.ResultSet, first));
    first = false;
    NextToken = page.NextToken;
  } while (NextToken && rows.length < maxRows);
  return rows.slice(0, maxRows);
}

module.exports = { runQuery, toObjects };
