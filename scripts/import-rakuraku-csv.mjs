import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opts = {
  db: 'cashflow_db',
  userId: null,
  csv: null,
  local: true,
  syncEntries: false,
  dryRun: false,
  batchSize: 500
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--db') opts.db = args[++i];
  else if (arg === '--user-id') opts.userId = Number(args[++i]);
  else if (arg === '--csv') opts.csv = args[++i];
  else if (arg === '--remote') opts.local = false;
  else if (arg === '--sync-entries') opts.syncEntries = true;
  else if (arg === '--dry-run') opts.dryRun = true;
  else if (arg === '--batch-size') opts.batchSize = Math.max(1, Number(args[++i]) || 500);
}

if (!opts.userId || !opts.csv) {
  console.error('Usage: node scripts/import-rakuraku-csv.mjs --user-id <id> --csv <path> [--db cashflow_db] [--remote] [--sync-entries] [--dry-run] [--batch-size 500]');
  process.exit(1);
}

const csvPath = path.resolve(opts.csv);
const sourceFileName = path.basename(csvPath);
const sourceFileHash = sha256Hex(fs.readFileSync(csvPath));
const raw = fs.readFileSync(csvPath);
const text = new TextDecoder('shift_jis', { fatal: false }).decode(raw);
const mojibakeCount = (text.match(/\uFFFD/g) || []).length;
const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
if (lines.length === 0) throw new Error('CSV is empty');

const header = parseCsvLine(cleanBom(lines[0]));
const expected = ['入出金管理No', '案件名', '出金合計(税込)', '入金合計(税込)', '顧客名', '予定日'];
for (const key of expected) {
  if (!header.includes(key)) throw new Error(`Required column missing: ${key}`);
}

const h = Object.fromEntries(header.map((k, i) => [k, i]));
const batchId = `rakuraku_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

let totalDataLines = 0;
let emptyLineCount = 0;
let rawCount = 0;
let entryCount = 0;
const acceptedRows = [];
const rowErrors = [];
const errorsByReason = Object.create(null);

for (let i = 1; i < lines.length; i += 1) {
  const line = lines[i] ?? '';
  if (isSkippableLine(line)) {
    emptyLineCount += 1;
    continue;
  }
  totalDataLines += 1;

  const cols = parseCsvLine(line);
  if (cols.length < header.length) {
    pushRowError(i, 'COLUMN_COUNT_MISMATCH', `Columns are fewer than header: ${cols.length}/${header.length}`);
    continue;
  }

  const managementNo = val(cols[h['入出金管理No']]);
  const projectName = val(cols[h['案件名']]);
  const expenseRaw = val(cols[h['出金合計(税込)']]).replaceAll(',', '');
  const incomeRaw = val(cols[h['入金合計(税込)']]).replaceAll(',', '');
  const customerName = val(cols[h['顧客名']]);
  const scheduledDateRaw = val(cols[h['予定日']]);

  const expenseParsed = parseYen(expenseRaw);
  const incomeParsed = parseYen(incomeRaw);
  const dateParsed = normalizeDate(scheduledDateRaw);

  const rowIssues = [];
  if (expenseParsed.error) rowIssues.push(expenseParsed.error);
  if (incomeParsed.error) rowIssues.push(incomeParsed.error);
  if (dateParsed.error) rowIssues.push(dateParsed.error);
  if (rowIssues.length > 0) {
    pushRowError(i, 'CONVERSION_ERROR', rowIssues.join('; '));
    continue;
  }

  const expense = expenseParsed.value;
  const income = incomeParsed.value;
  const scheduledDate = dateParsed.value;
  const rowHash = sha256Hex(JSON.stringify({ managementNo, projectName, expense, income, customerName, scheduledDate, sourceFileName }));

  acceptedRows.push({ rowNumber: i, managementNo, projectName, expense, income, customerName, scheduledDate, scheduledDateRaw, rowHash });
  rawCount += 1;
}

if (opts.syncEntries) {
  for (const row of acceptedRows) {
    if (row.income !== null && row.income > 0) entryCount += 1;
    if (row.expense !== null && row.expense > 0) entryCount += 1;
  }
}

let batchTableEnabled = false;
const startedAtMs = Date.now();

if (!opts.dryRun) {
  batchTableEnabled = tryCreateImportBatch(batchId, sourceFileName, sourceFileHash);
  const monthOrders = opts.syncEntries ? fetchMonthOrderMap(acceptedRows.map((r) => r.scheduledDate).filter(Boolean)) : new Map();

  const chunks = chunk(acceptedRows, opts.batchSize);
  for (let b = 0; b < chunks.length; b += 1) {
    const statements = ['BEGIN TRANSACTION;'];
    for (const row of chunks[b]) {
      statements.push(
        `INSERT OR IGNORE INTO rakuraku_cashflow_import_rows (user_id, import_batch_id, source_file_name, row_number, management_no, project_name, expense_total_incl_tax, income_total_incl_tax, customer_name, scheduled_date, scheduled_date_raw, row_hash) VALUES (${num(opts.userId)}, ${q(batchId)}, ${q(sourceFileName)}, ${num(row.rowNumber)}, ${qNull(row.managementNo)}, ${qNull(row.projectName)}, ${numNull(row.expense)}, ${numNull(row.income)}, ${qNull(row.customerName)}, ${qNull(row.scheduledDate)}, ${qNull(row.scheduledDateRaw)}, ${qNull(row.rowHash)});`
      );

      if (!opts.syncEntries || !row.scheduledDate) continue;
      const month = row.scheduledDate.slice(0, 7);
      const nextOrder = (monthOrders.get(month) ?? 0) + 1;
      monthOrders.set(month, nextOrder);

      const titleBase = row.projectName || row.managementNo || row.customerName || '楽々販売取込';
      if (row.income !== null && row.income > 0) {
        statements.push(
          `INSERT INTO cashflow_entries (user_id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, is_sample, is_completed, created_by_user_id, import_source_file_name, import_management_no, import_batch_id) VALUES (${num(opts.userId)}, ${q(limit120(titleBase))}, ${num(row.income)}, 'income', ${q(row.scheduledDate)}, ${num(nextOrder)}, NULL, NULL, NULL, ${qNull(row.customerName)}, NULL, '', 0, 0, ${num(opts.userId)}, ${q(sourceFileName)}, ${qNull(row.managementNo)}, ${q(batchId)});`
        );
      }
      if (row.expense !== null && row.expense > 0) {
        const nextOrder2 = (monthOrders.get(month) ?? nextOrder) + 1;
        monthOrders.set(month, nextOrder2);
        statements.push(
          `INSERT INTO cashflow_entries (user_id, title, amount, type, scheduled_date, order_index, note, account_name, actual_transaction_date, customer_name, staff_name, label_color, is_sample, is_completed, created_by_user_id, import_source_file_name, import_management_no, import_batch_id) VALUES (${num(opts.userId)}, ${q(limit120(titleBase))}, ${num(row.expense)}, 'expense', ${q(row.scheduledDate)}, ${num(nextOrder2)}, NULL, NULL, NULL, ${qNull(row.customerName)}, NULL, '', 0, 0, ${num(opts.userId)}, ${q(sourceFileName)}, ${qNull(row.managementNo)}, ${q(batchId)});`
        );
      }
    }
    statements.push('COMMIT;');
    executeSqlFile(statements.join('\n'));
    console.log(`Executed batch ${b + 1}/${chunks.length} (${chunks[b].length} rows)`);
  }

  if (batchTableEnabled) {
    const durationMs = Date.now() - startedAtMs;
    finishImportBatch(batchId, rawCount, rawCount, rowErrors.length, durationMs);
  }
}

printSummary({
  dryRun: opts.dryRun,
  batchId,
  sourceFileName,
  sourceFileHash,
  mojibakeCount,
  totalLines: Math.max(0, lines.length - 1),
  totalDataLines,
  emptyLineCount,
  importedRawRows: rawCount,
  insertedEntries: entryCount,
  skippedRows: rowErrors.length,
  errorsByReason,
  rowErrors
});

function tryCreateImportBatch(importBatchId, fileName, fileHash) {
  try {
    executeSqlCommand(
      `INSERT INTO rakuraku_cashflow_import_batches (user_id, import_batch_id, source_file_name, source_file_hash, status, total_rows, success_rows, failed_rows) VALUES (${num(opts.userId)}, ${q(importBatchId)}, ${q(fileName)}, ${q(fileHash)}, 'processing', 0, 0, 0);`
    );
    return true;
  } catch {
    return false;
  }
}

function finishImportBatch(importBatchId, totalRows, successRows, failedRows, durationMs) {
  executeSqlCommand(
    `UPDATE rakuraku_cashflow_import_batches SET status = 'completed', total_rows = ${num(totalRows)}, success_rows = ${num(successRows)}, failed_rows = ${num(failedRows)}, processing_time_ms = ${num(durationMs)}, finished_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ${num(opts.userId)} AND import_batch_id = ${q(importBatchId)};`
  );
}

function fetchMonthOrderMap(months) {
  const uniqueMonths = [...new Set(months.filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m)).map((d) => d.slice(0, 7)))];
  if (uniqueMonths.length === 0) return new Map();

  const inClause = uniqueMonths.map((m) => q(m)).join(', ');
  const sql = `SELECT substr(scheduled_date, 1, 7) AS month, COALESCE(MAX(order_index), 0) AS max_order FROM cashflow_entries WHERE user_id = ${num(opts.userId)} AND deleted_at IS NULL AND substr(scheduled_date, 1, 7) IN (${inClause}) GROUP BY substr(scheduled_date, 1, 7);`;
  const parsed = executeSqlCommandJson(sql);
  const map = new Map();
  const rows = parsed?.[0]?.results ?? [];
  for (const row of rows) {
    map.set(String(row.month), Number(row.max_order ?? 0));
  }
  for (const m of uniqueMonths) {
    if (!map.has(m)) map.set(m, 0);
  }
  return map;
}

function executeSqlCommandJson(sql) {
  const out = execWrangler(['d1', 'execute', opts.db, '--command', sql, ...(opts.local ? ['--local'] : ['--remote']), '--json'], false);
  const jsonText = extractJson(out);
  return JSON.parse(jsonText);
}

function executeSqlCommand(sql) {
  execWrangler(['d1', 'execute', opts.db, '--command', sql, ...(opts.local ? ['--local'] : ['--remote'])], true);
}

function executeSqlFile(sql) {
  const sqlPath = path.join(os.tmpdir(), `.tmp_rakuraku_import_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.sql`);
  fs.writeFileSync(sqlPath, sql, 'utf8');
  try {
    execWrangler(['d1', 'execute', opts.db, '--file', sqlPath, ...(opts.local ? ['--local'] : ['--remote'])], true);
  } finally {
    if (fs.existsSync(sqlPath)) fs.unlinkSync(sqlPath);
  }
}

function execWrangler(argv, inheritStdIO) {
  if (inheritStdIO) {
    execFileSync('npx', ['wrangler', ...argv], { stdio: 'inherit' });
    return '';
  }
  return execFileSync('npx', ['wrangler', ...argv], { encoding: 'utf8' });
}

function extractJson(text) {
  const start = text.indexOf('[');
  if (start < 0) throw new Error('Failed to parse wrangler JSON output');
  return text.slice(start).trim();
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function normalizeDate(v) {
  if (!v) return { value: null, error: null };
  const m = v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return { value: null, error: `Invalid date: ${v}` };
  const dateStr = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateStr) {
    return { value: null, error: `Out-of-range date: ${v}` };
  }
  return { value: dateStr, error: null };
}

function parseYen(v) {
  if (v === '') return { value: null, error: null };
  if (!/^-?\d+$/.test(v)) return { value: null, error: `Invalid amount: ${v}` };
  const n = Number(v);
  if (!Number.isFinite(n)) return { value: null, error: `Invalid amount: ${v}` };
  return { value: Math.trunc(n), error: null };
}

function printSummary(summary) {
  console.log('--- Import Summary ---');
  console.log(`Mode: ${summary.dryRun ? 'dry-run' : 'execute'}`);
  console.log(`Source: ${summary.sourceFileName}`);
  console.log(`Source SHA256: ${summary.sourceFileHash}`);
  console.log(`Batch ID: ${summary.batchId}`);
  console.log(`Input lines (excluding header): ${summary.totalLines}`);
  console.log(`Non-empty data lines: ${summary.totalDataLines}`);
  console.log(`Skipped empty lines: ${summary.emptyLineCount}`);
  console.log(`Imported raw rows: ${summary.importedRawRows}`);
  console.log(`Inserted cashflow_entries (planned): ${summary.insertedEntries}`);
  console.log(`Skipped rows (error): ${summary.skippedRows}`);
  console.log(`Mojibake chars detected (U+FFFD): ${summary.mojibakeCount}`);

  const reasons = Object.entries(summary.errorsByReason);
  if (reasons.length > 0) {
    console.log('Error breakdown:');
    for (const [reason, count] of reasons) {
      console.log(`- ${reason}: ${count}`);
    }
  }

  if (summary.rowErrors.length > 0) {
    const shown = summary.rowErrors.slice(0, 20);
    console.log(`Row errors (showing ${shown.length}/${summary.rowErrors.length}):`);
    for (const e of shown) {
      console.log(`- row ${e.rowNumber}: [${e.reason}] ${e.message}`);
    }
  }
}

function pushRowError(rowNumber, reason, message) {
  rowErrors.push({ rowNumber, reason, message });
  errorsByReason[reason] = (errorsByReason[reason] || 0) + 1;
}

function val(v) { return String(v ?? '').trim(); }
function q(v) { return `'${String(v).replaceAll("'", "''")}'`; }
function qNull(v) { return v ? q(v) : 'NULL'; }
function num(v) { return Number.isFinite(v) ? String(Math.trunc(v)) : '0'; }
function numNull(v) { return Number.isFinite(v) ? String(Math.trunc(v)) : 'NULL'; }
function limit120(v) { return String(v).slice(0, 120); }
function cleanBom(v) { return String(v ?? '').replace(/^\uFEFF/, ''); }
function isSkippableLine(v) { return String(v ?? '').trim() === ''; }
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
