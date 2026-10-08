/**
 * Job-material deployment automation (OpenRouter Edition).
 *
 * Revised pipeline:
 * 1. Read and parse structured markdown material files from SOURCE_FOLDER_ID.
 * 2. Route ingest/parse failures to FAILED_FOLDER_ID.
 * 3. Route already-processed Job IDs to DUPE_FOLDER_ID.
 * 4. Discover application routes and resolve a USPS single-line company mailing address.
 * 5. Generate resume, cover-letter, and LinkedIn Google Docs (DOCGEN).
 * 6. Route DOCGEN failures to FAILED_FOLDER_ID.
 * 7. Optionally render PDF/.desktop package artifacts when ENABLE_RENDER is true (disabled by default).
 * 8. Independently dispatch Gmail drafts/messages; dispatch failure never invalidates successful DOCGEN.
 * 9. Upsert one Applications row per Job ID with core/render/dispatch/recipient state; store unmatched DSNs in a separate Bounce Audit sheet.
 * 10. Dual-log execution events to Apps Script console and a per-run Google Doc log file.
 * 11. Move successfully generated source material to PROCESSED_FOLDER_ID regardless of dispatch outcome.
 * 12. Detect/classify standards-based delivery-status notifications (Gmail and external mail systems), persist selective suppression, and archive logged bounce threads.
 * 13. Gracefully halt file processing if approaching the 5-minute execution limit.
 */

// ============================================================================
// 🚀 EMAIL DISPATCH & LOGGING CONFIGURATION
// ============================================================================

// TRUE  = Automatically SEND the emails immediately upon generation.
// FALSE = ONLY CREATE DRAFTS in your Gmail folder for manual review.
const AUTO_SEND_EMAILS = true;

// Set to false to completely disable both drafting and sending emails.
const ENABLE_EMAIL_DISPATCH = true;

// Append a compact transparency note to the dispatched email body only.
// This does not modify the generated cover-letter document.
const ENABLE_APPLICATION_TRANSPARENCY_FOOTER = true;
const ASTRO_PROJECT_URL = 'https://github.com/sudoTni/AstroOM';

// Render workflow is opt-in. DOCGEN remains active when rendering is disabled.
const ENABLE_RENDER = false;

// Bounce scanning policy.
const BOUNCE_SCAN_LOOKBACK_DAYS = 14;
const BOUNCE_SCAN_MAX_THREADS = 100;

// Centralized logging configuration
const LOG_LEVELS = Object.freeze({
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4
});
const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO; // Default to INFO in production (options: DEBUG, INFO, WARN, ERROR)
const ENABLE_SPREADSHEET_LOGGING = true;
const ENABLE_DOC_LOGGING = true;
const DEFAULT_DOC_LOG_FOLDER_ID = '1opblh5TCDX7AslZK3hBESKZGJNYW-6XR';
const DOC_LOG_FOLDER_ID = DEFAULT_DOC_LOG_FOLDER_ID; // Backward-compatibility alias
const DOC_LOG_FILE_NAME_PREFIX = 'AstroEX-RunLog';
const DOC_LOG_FILE_TS_FORMAT = 'yyyyMMdd-HHmmss-SSS';

// ============================================================================

/**
 * Script Property names.
 * Configure these in Apps Script Project Settings -> Script Properties.
 * TARGET_FOLDER_ID_RENDER is required only when ENABLE_RENDER is true.
 */
const SCRIPT_PROPERTIES = Object.freeze({
  SOURCE_FOLDER_ID: 'SOURCE_FOLDER_ID',
  TARGET_FOLDER_ID: 'TARGET_FOLDER_ID',
  TARGET_FOLDER_ID_RENDER: 'TARGET_FOLDER_ID_RENDER',
  PROCESSED_FOLDER_ID: 'PROCESSED_FOLDER_ID',
  FAILED_FOLDER_ID: 'FAILED_FOLDER_ID',
  DUPE_FOLDER_ID: 'DUPE_FOLDER_ID',
  RESUME_TEMPLATE_ID: 'RESUME_TEMPLATE_ID',
  COVER_LETTER_TEMPLATE_ID: 'COVER_LETTER_TEMPLATE_ID',
  OR_API_KEY: 'OR_API_KEY', // REPLACED: POE_API_KEY -> OR_API_KEY
  SPREADSHEET_LOG_ID: 'SPREADSHEET_LOG_ID',
  APPLICANT_NAME: 'APPLICANT_NAME',
  APPLICANT_EMAIL: 'APPLICANT_EMAIL',
  DOC_LOG_FOLDER_ID: 'DOC_LOG_FOLDER_ID'
});

/**
 * OpenRouter / LLM configuration.
 */
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'google/gemini-3.1-flash-lite';
const OPENROUTER_REQUEST_TIMEOUT_SECONDS = 30;
const OPENROUTER_MAX_ATTEMPTS = 2;
const OPENROUTER_RETRY_BASE_DELAY_MS = 1500;
const OPENROUTER_DEFAULT_MAX_TOKENS = 1400;
const OPENROUTER_DISCOVERY_MAX_TOKENS = 1400;
const OPENROUTER_ADDRESS_MAX_TOKENS = 256;
const OPENROUTER_MAX_RESPONSE_CHARS = 24000;
const SAFE_EXECUTION_LIMIT_MS = 5 * 60 * 1000;
const OPENROUTER_EXECUTION_CUSHION_MS = 5000;

/**
 * Routing policy.
 */
const APPLICATION_DRAFT_MODE = 'HAIL_MARY';

const APPLICATION_EMAIL_HIGH_SCORE = 85;
const APPLICATION_EMAIL_MEDIUM_SCORE = 65;
const APPLICATION_EMAIL_HAIL_MARY_SCORE = 45;
const APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE = 0.55;
const MAX_DISCOVERY_CANDIDATES_TO_LOG = 5;
const MAX_DISCOVERY_CANDIDATES_TO_ANNOTATE = 8;

/**
 * Execution & Validation Policies.
 */
const STRICT_GMAIL_FROM_VALIDATION = false;
const PREFLIGHT_GMAIL_DRAFT_AUTH = true;
const MOVE_SOURCE_FILE_AFTER_SUCCESS = true;
const ANNOTATE_DRIVE_FILES_WITH_DISCOVERY = true;
const ATTACH_RESUME_PDF = true;
const REUSE_EXISTING_GENERATED_FILES = true;
const REQUIRE_TEMPLATE_PLACEHOLDER_COMPLETION = true;
const INCLUDE_VISIBLE_JOB_URL_IN_RESUME = false;
const VISIBLE_JOB_URL_LABEL = 'Job posting';
const STRIP_LINKEDIN_FROM_RESUME_HEADER = false;
const LOG_STATUS_INGEST_PARSE_FAILED = 'INGEST_PARSE_FAILED';
const LOG_STATUS_DOCGEN_FAILED = 'DOCGEN_FAILED';
const LOG_STATUS_CORE_PROCESSED = 'CORE_PROCESSED';
const LOG_STATUS_DUPLICATE = 'DUPLICATE';
const LOG_STATUS_RENDER_FAILED = 'RENDER_FAILED';
const LOG_STATUS_NO_DRAFTABLE_ROUTE = 'NO_DRAFTABLE_ROUTE';
const LOG_STATUS_DISPATCH_DISABLED = 'DISPATCH_DISABLED';
const LOG_STATUS_DISPATCH_FAILED = 'DISPATCH_FAILED';
const LOG_STATUS_SUPPRESSED_BOUNCE = 'SUPPRESSED_BOUNCE';
const LOG_STATUS_BOUNCE_UNMATCHED = 'BOUNCE_UNMATCHED';
const LOG_STATUS_BOUNCE_RECONCILED = 'BOUNCE_RECONCILED';
const LOG_EMAIL_TIER_NO_DRAFTABLE_ROUTE = 'NO_DRAFTABLE_ROUTE';
const LOG_EMAIL_TIER_DISPATCH_DISABLED = 'DISPATCH_DISABLED';
const LOG_EMAIL_TIER_DISPATCH_FAILED = 'DISPATCH_FAILED';
const LOG_EMAIL_TIER_SUPPRESSED_BOUNCE = 'SUPPRESSED';

const APPLICATIONS_SHEET_NAME = 'Applications';
const BOUNCE_AUDIT_SHEET_NAME = 'Bounce Audit';
const MAX_APPLICATION_RECIPIENT_SLOTS = 5;
const LOG_STATUS_RENDER_COMPLETE = 'RENDER_COMPLETE';
const LOG_STATUS_RENDER_DISABLED = 'RENDER_DISABLED';
const LOG_STATUS_PARTIAL_DELIVERY = 'PARTIAL_DELIVERY';

const LEGACY_SPREADSHEET_LOG_HEADERS = Object.freeze([
  'Timestamp', 'Status', 'Company', 'Job ID', 'Job Title', 'Target Email', 'Email Tier', 'Score', 'Draft/Message ID', 'Job URL',
  'Bounce Type', 'Bounce Code', 'Bounce Suppressed', 'Bounce Message ID', 'Bounce Detected At'
]);

function buildApplicationsSheetHeaders() {
  const headers = [
    'Created At', 'Updated At', 'Company', 'Job ID', 'Job Title', 'Job URL', 'Company Address',
    'Core Status', 'Core Completed At', 'Core Error',
    'Render Status', 'Render Completed At', 'Render Error',
    'Dispatch Status', 'Dispatch Completed At', 'Dispatch Error',
    'Discovery Score', 'Source File Name', 'Duplicate Count', 'Last Duplicate Detected At',
    'Last Run ID', 'Notes'
  ];
  for (let slot = 1; slot <= MAX_APPLICATION_RECIPIENT_SLOTS; slot++) {
    headers.push(
      `Recipient ${slot} Email`,
      `Recipient ${slot} Tier`,
      `Recipient ${slot} Score`,
      `Recipient ${slot} Delivery Status`,
      `Recipient ${slot} Message ID`,
      `Recipient ${slot} Bounce Type`,
      `Recipient ${slot} Bounce Code`,
      `Recipient ${slot} Bounce Suppressed`,
      `Recipient ${slot} Bounce Message ID`,
      `Recipient ${slot} Bounce Detected At`
    );
  }
  return headers;
}

const APPLICATIONS_SHEET_HEADERS = Object.freeze(buildApplicationsSheetHeaders());

const BOUNCE_AUDIT_HEADERS = Object.freeze([
  'Detected At', 'Gmail Message ID', 'Gmail Thread ID', 'Status',
  'Bounce Type', 'Bounce Code', 'Bounce Suppressed', 'Target Email',
  'Subject', 'Diagnostic', 'Archived At', 'Run ID', 'Notes'
]);

const BOUNCE_TYPES = Object.freeze({
  INVALID_RECIPIENT: Object.freeze({ id: 'INVALID_RECIPIENT', label: 'Recipient address does not exist / invalid address' }),
  POLICY_SPAM_SECURITY: Object.freeze({ id: 'POLICY_SPAM_SECURITY', label: 'Spam, reputation, security, or policy rejection' }),
  SENDER_LIMIT: Object.freeze({ id: 'SENDER_LIMIT', label: 'Sender has reached a sending limit' }),
  TEMPORARY_DELIVERY: Object.freeze({ id: 'TEMPORARY_DELIVERY', label: 'Temporary recipient/server delivery problem' }),
  MAILBOX_FULL: Object.freeze({ id: 'MAILBOX_FULL', label: 'Recipient mailbox full / out of storage / receiving too quickly' }),
  HELO_EHLO_ERROR: Object.freeze({ id: 'HELO_EHLO_ERROR', label: 'HELO/EHLO / SMTP server identification error' })
});

/**
 * Canonical placeholder names expected in the templates.
 */
const TEMPLATE_PLACEHOLDERS = Object.freeze({
  CUSTOM_PROF_TITLE: '{{custom_prof_title}}',
  CUSTOM_PROF_SUMMARY: '{{custom_prof_summary}}',
  CUSTOM_SKILLS: '{{custom_skills}}',
  JOB_URL: '{{job_url}}',
  TODAYS_DATE: '{{todays_date}}',
  JOB_COMPANY_ADDRESS: '{{job_company_address}}',
  JOB_COMPANY: '{{job_company}}',
  COVER_BODY: '{{cover_body}}'
});

/**
 * Global Regex Patterns (Instantiated once for memory efficiency)
 */
const LINKEDIN_PATTERNS = [
  '\\s*[•|]\\s*https*://[w.]*linkedin\\.com/[^ •|\\n]+\\s*[•|]?\\s*',
  '\\s*https*://[w.]*linkedin\\.com/[^ •|\\n]+\\s*[•|]?\\s*',
  '\\s*[•|]?\\s*[w.]*linkedin\\.com/[^ •|\\n]+\\s*[•|]?\\s*',
  '\\s*[•|]?\\s*LinkedIn\\s*[•|]?\\s*'
];

const SEPARATOR_PATTERNS =[
  { search: '\\s*[•|]\\s*[•|]\\s*', replace: ' • ' },
  { search: '^\\s*[•|]\\s*', replace: '' },
  { search: '\\s*[•|]\\s*$', replace: '' },
  { search: '^\\s+', replace: '' },
  { search: '\\s+$', replace: '' }
];

/**
 * Discovery tiers & actions.
 */
const DISCOVERY_TIERS = Object.freeze({
  OFFICIAL_APPLICATION_INTAKE: 'OFFICIAL_APPLICATION_INTAKE',
  OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT: 'OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT',
  OFFICIAL_GENERAL_CONTACT: 'OFFICIAL_GENERAL_CONTACT',
  PUBLIC_RECRUITER_OR_HIRING_TEAM: 'PUBLIC_RECRUITER_OR_HIRING_TEAM',
  OTHER_PUBLIC_ROUTE: 'OTHER_PUBLIC_ROUTE',
  SUPPRESSED: 'SUPPRESSED'
});

const DISCOVERY_ACTIONS = Object.freeze({
  CREATE_DRAFT: 'create_draft',
  BACKUP_ONLY: 'backup_only',
  SUPPRESS: 'suppress'
});

// ============================================================================
// 💾 IN-MEMORY CACHE FOR GOOGLE APIS
// ============================================================================
let CACHED_GMAIL_ALIASES = null;
let CACHED_EFFECTIVE_USER_EMAIL = null;
let CACHED_BOUNCED_ADDRESS_SET = null;
let APPLICATION_RECONCILIATION_COMPLETED = false;

// ============================================================================
// 📝 STANDARDIZED DUAL-LOGGING SYSTEM & EXECUTION METRICS
// ============================================================================

const RUN_METRICS = {
  runId: Utilities.getUuid(),
  startTime: Date.now(),
  filesDiscovered: 0,
  filesProcessed: 0,
  filesSkipped: 0,
  filesFailed: 0,
  filesDuplicated: 0,
  emailsSent: 0,
  emailsDrafted: 0,
  routesUnresolved: 0,
  renderFailures: 0,
  dispatchFailures: 0,
  errorsEncountered: 0,
  bouncesDetected: 0,
  bouncesArchived: 0,
  timeLimitReached: false
};

const SCRIPT_LOG_BUFFER =[];
const DOC_LOG_RUN_MARKER_PREFIX = '[DOC_RUN_START]';
const DOC_LOG_CURRENT_RUN_TIMESTAMP = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', DOC_LOG_FILE_TS_FORMAT);
const DOC_LOG_CURRENT_RUN_ID = RUN_METRICS.runId;
const DOC_LOG_CURRENT_RUN_MARKER = `${DOC_LOG_RUN_MARKER_PREFIX} ${DOC_LOG_CURRENT_RUN_TIMESTAMP} | ${DOC_LOG_CURRENT_RUN_ID}`;
let DOC_LOG_RUN_MARKER_WRITTEN = false;
let DOC_LOG_CURRENT_RUN_DOC_ID = '';
let DOC_LOG_CURRENT_RUN_DOC_NAME = '';

/**
 * Standardized Logger for console and Google Doc targets.
 */
const AppLogger = {
  formatLine(level, component, message, context) {
    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd HH:mm:ss.SSS');
    const paddedLevel = String(level).padEnd(5, ' ');
    const compStr = component ? `[${String(component).trim()}]`.padEnd(12, ' ') : '';
    let line = `[${ts}] [${paddedLevel}] ${compStr} ${message}`;
    if (context && typeof context === 'object' && Object.keys(context).length > 0) {
      const ctxStr = Object.entries(context)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
        .join(' ');
      line += ` | ${ctxStr}`;
    }
    return line;
  },

  log(levelName, component, message, context) {
    const levelVal = LOG_LEVELS[levelName] || LOG_LEVELS.INFO;
    if (levelVal < CURRENT_LOG_LEVEL) return;
    const formatted = this.formatLine(levelName, component, message, context);
    Logger.log(formatted);
    if (ENABLE_DOC_LOGGING) {
      SCRIPT_LOG_BUFFER.push({ level: levelName, component, message, text: formatted });
    }
  },

  debug(comp, msg, ctx) { this.log('DEBUG', comp, msg, ctx); },
  info(comp, msg, ctx)  { this.log('INFO', comp, msg, ctx); },
  warn(comp, msg, ctx)  { this.log('WARN', comp, msg, ctx); },
  error(comp, msg, ctx) {
    RUN_METRICS.errorsEncountered++;
    this.log('ERROR', comp, msg, ctx);
  },

  vLog(message) {
    const raw = String(message || '').trim();
    // Normalize and extract component tag if message is bracketed e.g. [ORCHESTRATOR]
    const match = raw.match(/^(?:[-*•\s]*)(?:\[([A-Za-z0-9_\-\s]+)\])?\s*(.*)$/);
    let tag = match && match[1] ? match[1].trim() : 'GENERAL';
    let rest = match && match[2] ? match[2].trim() : raw;

    let level = 'INFO';
    if (/\b(?:warning|warn)\b/i.test(tag) || /\b(?:warning|warn)\b/i.test(rest) || /⚠️/.test(raw)) {
      level = 'WARN';
    } else if (/\b(?:error|fatal|fail)\b/i.test(tag) || /\b(?:error|fatal|fail)\b/i.test(rest) || /❌/.test(raw)) {
      level = 'ERROR';
    } else if (/\b(?:lazy|debug|detail)\b/i.test(tag) || /Parsing Message|Evaluating Thread/i.test(rest)) {
      level = 'DEBUG';
    }

    // Map common subsystem tags to canonical abbreviations
    tag = tag.replace(/ORCHESTRATOR|CORE/i, 'ORCHESTR')
             .replace(/EMAIL ENGINE|DISPATCH/i, 'DISPATCH')
             .replace(/BOUNCE TRACKER|BOUNCE SUPPRESSION|BOUNCES/i, 'BOUNCES')
             .replace(/LLM GATEWAY|API EXECUTION|API SUCCESS|API ERROR|LLM/i, 'LLM')
             .replace(/ADDRESS FORMATTING|ADDRESS SCRAPER/i, 'GENERAL')
             .replace(/RESUME GENERATOR|COVER LETTER GENERATOR|LINKEDIN DOC GENERATOR|TEMPLATE ENGINE|REPLACE ENGINE|LINK ENGINE|DRIVE|DOCGEN/i, 'DOCGEN')
             .replace(/RENDER ENGINE|RENDER/i, 'RENDER')
             .replace(/DISCOVERY MODULE|DISCOVERY|NORMALIZER|PROMPT BUILDER|ROUTING/i, 'ROUTING')
             .replace(/PRE-FILTER|PREFILTER|AUTH|PREFLIGHT/i, 'PREFLIGHT')
             .replace(/PARSER/i, 'PARSER')
             .replace(/SHEET LOG|SPREADSHEET|SHEET/i, 'SHEET');

    // Clean leading bracket remnants from rest of message
    rest = rest.replace(/^\[(?:WARNING|ERROR|FATAL|SUCCESS|CORE|LAZY)\]\s*/i, '').replace(/^[❌⚠️🚀📥⏳🏁🛑]\s*/, '');
    this.log(level, tag.substring(0, 10), rest);
  }
};

/**
 * Global backward-compatibility bridge for all existing vLog() call sites.
 */
function vLog(message) {
  AppLogger.vLog(message);
}

function getOrCreateRunDocLogTarget(folderIdOverride) {
  if (DOC_LOG_CURRENT_RUN_DOC_ID) return DOC_LOG_CURRENT_RUN_DOC_ID;
  const targetFolderId = folderIdOverride || DOC_LOG_FOLDER_ID;
  if (!targetFolderId) {
    throw new Error('DOC_LOG_FOLDER_ID is empty. Configure it in Script Properties or EMAIL DISPATCH & LOGGING CONFIGURATION.');
  }

  const folder = DriveApp.getFolderById(targetFolderId);
  DOC_LOG_CURRENT_RUN_DOC_NAME = `${DOC_LOG_FILE_NAME_PREFIX}-${DOC_LOG_CURRENT_RUN_TIMESTAMP}-${DOC_LOG_CURRENT_RUN_ID}`;
  const doc = DocumentApp.create(DOC_LOG_CURRENT_RUN_DOC_NAME);
  DOC_LOG_CURRENT_RUN_DOC_ID = doc.getId();
  const file = DriveApp.getFileById(DOC_LOG_CURRENT_RUN_DOC_ID);
  file.moveTo(folder);

  return DOC_LOG_CURRENT_RUN_DOC_ID;
}

/**
 * Flushes the accumulated log buffer to the current run's Google Doc,
 * applying structured typography (Headings, Monospace, Tables) and safely locks/closes it.
 */
function flushDocLogs(folderIdOverride) {
  if (!ENABLE_DOC_LOGGING || SCRIPT_LOG_BUFFER.length === 0) return;
  try {
    const docId = getOrCreateRunDocLogTarget(folderIdOverride);
    const doc = DocumentApp.openById(docId);
    const body = doc.getBody();

    if (!DOC_LOG_RUN_MARKER_WRITTEN) {
      const firstP = body.getParagraphs()[0];
      const titleText = `AstroEX Run Log: ${DOC_LOG_CURRENT_RUN_TIMESTAMP}`;
      if (firstP && firstP.getText() === '') {
        firstP.editAsText().setText(titleText);
        if (firstP.setHeading) firstP.setHeading(DocumentApp.ParagraphHeading.HEADING1);
      } else {
        const titleP = body.appendParagraph(titleText);
        if (titleP && titleP.setHeading) titleP.setHeading(DocumentApp.ParagraphHeading.HEADING1);
      }
      const subP = body.appendParagraph(`Run ID: ${DOC_LOG_CURRENT_RUN_ID}`);
      subP.setFontFamily('Courier New').setFontSize(9).setForegroundColor('#666666');
      DOC_LOG_RUN_MARKER_WRITTEN = true;
    }

    const itemsToFlush = SCRIPT_LOG_BUFFER.splice(0, SCRIPT_LOG_BUFFER.length);

    for (let i = 0; i < itemsToFlush.length; i++) {
      const item = itemsToFlush[i];

      // Handle Executive Summary Block with structured Google Doc Table
      if (typeof item === 'object' && item !== null && item.isSummary) {
        const summaryHeading = body.appendParagraph('Execution Run Summary');
        if (summaryHeading && summaryHeading.setHeading) {
          summaryHeading.setHeading(DocumentApp.ParagraphHeading.HEADING1);
        }
        const tableData = [
          ['Metric', 'Value'],
          ['Run ID', String(RUN_METRICS.runId)],
          ['Execution Duration', `${item.elapsedSec} seconds`],
          ['Time Limit Reached', RUN_METRICS.timeLimitReached ? 'YES (Batch paused at 5-min threshold)' : 'NO (Completed within window)'],
          ['Files Discovered', String(RUN_METRICS.filesDiscovered)],
          ['Files Processed (DOCGEN complete)', String(RUN_METRICS.filesProcessed)],
          ['Files Skipped', String(RUN_METRICS.filesSkipped)],
          ['Files Failed', String(RUN_METRICS.filesFailed)],
          ['Duplicates Diverted', String(RUN_METRICS.filesDuplicated)],
          ['Emails Sent', String(RUN_METRICS.emailsSent)],
          ['Emails Drafted', String(RUN_METRICS.emailsDrafted)],
          ['Unresolvable Routes', String(RUN_METRICS.routesUnresolved)],
          ['Render Failures', String(RUN_METRICS.renderFailures)],
          ['Dispatch Failures', String(RUN_METRICS.dispatchFailures)],
          ['Errors Encountered', String(RUN_METRICS.errorsEncountered)],
          ['Bounces Detected', String(RUN_METRICS.bouncesDetected)],
          ['Bounce Threads Archived', String(RUN_METRICS.bouncesArchived)],
          ['Suppressed Address Set', `${CACHED_BOUNCED_ADDRESS_SET ? CACHED_BOUNCED_ADDRESS_SET.size : 0} addresses`]
        ];
        const table = body.appendTable(tableData);
        try {
          const headerRow = table.getRow(0);
          for (let c = 0; c < 2; c++) {
            const cell = headerRow.getCell(c);
            cell.editAsText().setBold(true);
            cell.setBackgroundColor('#E8EAED');
          }
        } catch (tableStyleErr) {}
        continue;
      }

      const rawStr = typeof item === 'string' ? item : (item && item.text ? item.text : String(item));
      const lines = rawStr.split('\n');
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        const trimmed = line.trim();
        if (!trimmed || /^={10,}$/.test(trimmed)) continue;

        // Detect file processing transition to apply Heading 2
        const fileMatch = trimmed.match(/Loading Material File:\s*(.+?)(?:\s*\(ID:|\s*$)/i);
        if (fileMatch) {
          const heading = body.appendParagraph(`File: ${fileMatch[1].trim()}`);
          if (heading && heading.setHeading) {
            heading.setHeading(DocumentApp.ParagraphHeading.HEADING2);
          }
          continue;
        }

        const p = body.appendParagraph(line);
        p.setFontFamily('Courier New').setFontSize(9);
        if (/\[ERROR\]|\[FATAL\]|❌/i.test(line)) {
          p.setForegroundColor('#C62828');
        } else if (/\[WARN\s*\]|⚠️/i.test(line)) {
          p.setForegroundColor('#E65100');
        } else if (/\[DEBUG\]/i.test(line)) {
          p.setForegroundColor('#757575');
        }
      }
    }

    doc.saveAndClose(); // Guarantee unbuffered write persistence
  } catch (e) {
    Logger.log(`[ERROR] Failed to flush logs to Google Doc: ${e.message}`);
  }
}

/**
 * Emits an executive run summary block to the log buffer and console.
 */
function outputExecutionSummary() {
  const elapsedSec = ((Date.now() - RUN_METRICS.startTime) / 1000).toFixed(1);
  const summaryLines = [
    '',
    '================================================================================',
    `                       EXECUTION RUN SUMMARY: ${DOC_LOG_FILE_NAME_PREFIX}`,
    '================================================================================',
    `Run ID:                 ${RUN_METRICS.runId}`,
    `Execution Duration:     ${elapsedSec} seconds`,
    `Time Limit Reached:     ${RUN_METRICS.timeLimitReached ? 'YES (Batch paused at 5-min threshold)' : 'NO (Completed within window)'}`,
    '',
    'INTAKE & DISPATCH METRICS:',
    `  - Files Discovered:       ${RUN_METRICS.filesDiscovered}`,
    `  - Files Processed:        ${RUN_METRICS.filesProcessed}`,
    `  - Files Skipped:          ${RUN_METRICS.filesSkipped}`,
    `  - Files Failed:           ${RUN_METRICS.filesFailed}`,
    `  - Duplicates Diverted:    ${RUN_METRICS.filesDuplicated}`,
    `  - Emails Sent:            ${RUN_METRICS.emailsSent}`,
    `  - Emails Drafted:         ${RUN_METRICS.emailsDrafted}`,
    `  - Unresolvable Routes:    ${RUN_METRICS.routesUnresolved}`,
    `  - Render Failures:        ${RUN_METRICS.renderFailures}`,
    `  - Dispatch Failures:      ${RUN_METRICS.dispatchFailures}`,
    `  - Errors Encountered:     ${RUN_METRICS.errorsEncountered}`,
    '',
    'BOUNCE DETECTION & SUPPRESSION:',
    `  - Bounces Detected:       ${RUN_METRICS.bouncesDetected}`,
    `  - Threads Archived:       ${RUN_METRICS.bouncesArchived}`,
    `  - Suppressed Address Set: ${CACHED_BOUNCED_ADDRESS_SET ? CACHED_BOUNCED_ADDRESS_SET.size : 0} addresses`,
    '================================================================================',
    ''
  ];
  const summaryBlock = summaryLines.join('\n');
  Logger.log(summaryBlock);
  if (ENABLE_DOC_LOGGING) {
    SCRIPT_LOG_BUFFER.push({
      isSummary: true,
      elapsedSec: elapsedSec,
      rawText: summaryBlock
    });
  }
}

// ============================================================================

/**
 * One-time helper. Run manually after adding Gmail scopes if authorization is stale.
 */
function authorizeGmailDrafting() {
  vLog('[AUTH] Requesting required configurations for Gmail authorization flow...');
  const config = getRequiredDeploymentConfig();
  vLog('[AUTH] Creating authorization test draft...');
  GmailApp.createDraft(config.applicantEmail, 'Apps Script Gmail Draft Authorization Test', 'This draft was created to authorize Gmail draft permissions. You may delete it.');
  vLog('[AUTH] Authorization test draft created successfully. You may delete it from Gmail.');
  flushDocLogs();
}

/**
 * Performs an early Gmail authorization check. Uses CacheService to prevent redundant API calls.
 */
function preflightGmailDraftAuthorization(config) {
  vLog('[PREFLIGHT] Running Gmail preflight authorization check...');
  if (!PREFLIGHT_GMAIL_DRAFT_AUTH || !ENABLE_EMAIL_DISPATCH || APPLICATION_DRAFT_MODE === 'OFF') {
    vLog('[PREFLIGHT] Gmail preflight skipped based on configuration flags.');
    return;
  }

  const cache = CacheService.getScriptCache();
  if (cache.get('gmail_auth_ok')) {
    vLog('[PREFLIGHT] Gmail preflight: Authorization status found in memory cache. Status: OK.');
    return;
  }

  if (STRICT_GMAIL_FROM_VALIDATION) {
    if (!canUseGmailFromAddress(config.applicantEmail)) {
      const aliases = getNormalizedGmailAliases();
      throw new Error(
        `Configured APPLICANT_EMAIL (${config.applicantEmail}) is not authorized as a Gmail From address. ` +
        `Add it as a verified alias or disable STRICT_GMAIL_FROM_VALIDATION. Known aliases: ${aliases.join(', ') || 'NONE'}`
      );
    }
    vLog(`[PREFLIGHT] Strict From-address validation passed for: ${config.applicantEmail}`);
  }

  let draft = null;
  try {
    vLog('[PREFLIGHT] Generating tentative test draft payload...');
    draft = GmailApp.createDraft(
      config.applicantEmail,
      'Apps Script Gmail Draft Preflight',
      'Temporary authorization preflight draft. This draft should be deleted automatically.'
    );
    vLog('  - [PREFLIGHT] Gmail preflight: Gmail draft generation is authorized.');

    try {
      draft.deleteDraft();
      cache.put('gmail_auth_ok', 'true', 21600); // Cache success for 6 hours
      vLog('  - [PREFLIGHT] temporary preflight draft removed and status successfully cached.');
    } catch (deleteError) {
      vLog(`  - [PREFLIGHT] Notice: Preflight draft could not be automatically deleted: ${deleteError.message}`);
    }
  } catch (e) {
    vLog(`  - [PREFLIGHT] [WARNING] Gmail preflight authorization failed: ${e.message}`);
  }
}

/**
 * Performs an early Spreadsheet authorization check.
 */
function preflightSpreadsheetAuthorization(config) {
  vLog('[PREFLIGHT] Running Spreadsheet preflight authorization check...');
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) {
    vLog('[PREFLIGHT] Spreadsheet preflight skipped based on configuration.');
    return;
  }
  try {
    vLog(`[PREFLIGHT] Attempting connection check to sheet ID: ${config.spreadsheetLogId}`);
    SpreadsheetApp.openById(config.spreadsheetLogId);
    vLog(`  - [PREFLIGHT] Spreadsheet preflight: Spreadsheet access is verified.`);
  } catch (e) {
    vLog(`  - [PREFLIGHT] [WARNING] Spreadsheet access check failed: ${e.message}`);
  }
}

/**
 * Scans delivery-status notifications (Gmail and external mail systems), classifies
 * the six supported bounce categories, updates the corresponding spreadsheet
 * recipient slot, and archives only after the bounce event has been durably logged.
 */
function scanForBounces(config) {
  vLog('[BOUNCE TRACKER] Initiating six-type delivery-status notification scan...');
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) {
    vLog('  - [BOUNCE TRACKER] Spreadsheet logging disabled. Skipping bounce scan.');
    return;
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetLogId);
    const applicationsSheet = getOrCreateApplicationsSheet(spreadsheet);
    const bounceAuditSheet = getOrCreateBounceAuditSheet(spreadsheet);
    normalizeHistoricalTemporaryBounceClassifications(applicationsSheet, bounceAuditSheet);
    reconcileBounceAuditEvents(applicationsSheet, bounceAuditSheet);
    const sentJobs = loadBounceTrackingJobs(applicationsSheet);
    const loggedBounceMessageIds = getLoggedBounceMessageIds(applicationsSheet, bounceAuditSheet);

    vLog(`  - [BOUNCE TRACKER] Applications sheet contains ${applicationsSheet.getLastRow()} total row(s).`);
    vLog(`  - [BOUNCE TRACKER] Loaded ${sentJobs.length} application row(s) containing trackable recipient statuses.`);

    const query = `in:inbox newer_than:${BOUNCE_SCAN_LOOKBACK_DAYS}d {from:mailer-daemon from:postmaster subject:"Delivery Status Notification" subject:"Undeliverable" subject:"Mail delivery failed" subject:"Returned mail" subject:"Delivery failure" subject:"Failure notice" subject:"Delivery delayed" subject:"Delivery incomplete"}`;
    vLog(`  - [BOUNCE TRACKER] Querying Gmail with filter: ${query}`);
    const threads = GmailApp.search(query, 0, BOUNCE_SCAN_MAX_THREADS);
    vLog(`  - [BOUNCE TRACKER] Found ${threads.length} candidate delivery-status thread(s).`);

    let bounceCount = 0;
    let archivedThreadCount = 0;

    threads.forEach((thread, threadIdx) => {
      let threadCanArchive = false;
      let threadHasUnpersistedRecognizedBounce = false;
      const persistedMessageIds = [];
      const messages = thread.getMessages();
      const threadId = (() => {
        try { return String(thread.getId() || ''); } catch (e) { return ''; }
      })();
      vLog(`  - [BOUNCE TRACKER] Evaluating Thread #${threadIdx + 1} (${messages.length} message(s)).`);

      messages.forEach((msg, msgIdx) => {
        const messageId = String(msg.getId() || '').trim();
        const messageWasPreviouslyLogged = Boolean(messageId && loggedBounceMessageIds.has(messageId));

        const body = String(msg.getPlainBody() || '');
        const subject = String(msg.getSubject() || '');
        let rawContent = '';
        try {
          rawContent = String(msg.getRawContent() || '');
        } catch (rawErr) {
          vLog(`    - [BOUNCE TRACKER] [WARNING] Could not inspect raw DSN content: ${rawErr.message}`);
        }

        if (!isDeliveryStatusNotificationMessage(msg, rawContent, body, subject)) {
          vLog(`    - [BOUNCE TRACKER] Message #${msgIdx + 1} is part of the matched thread but does not satisfy DSN validation; skipping classification.`);
          return;
        }

        const classification = classifyGmailBounce(`${subject}\n${body}\n${rawContent}`);
        if (!classification) {
          vLog(`    - [BOUNCE TRACKER] Message #${msgIdx + 1} is a validated DSN but did not match one of the six configured bounce categories.`);
          return;
        }

        if (messageWasPreviouslyLogged) {
          vLog(`    - [BOUNCE TRACKER] DSN ${messageId} already logged; skipping duplicate mutation and retaining thread for archive retry.`);
          threadCanArchive = true;
          persistedMessageIds.push(messageId);
          return;
        }

        const searchable = `${subject}\n${body}\n${rawContent}`.toLowerCase();
        const authoritativeRecipients = extractBounceRecipientCandidates(`${body}\n${rawContent}`, config);
        const resolvedTargets = resolveBounceTargets(sentJobs, searchable, authoritativeRecipients);
        const suppressRecipient = shouldSuppressBounceRecipient(classification);
        const detectedAt = getCurrentTimestampString();
        let messagePersisted = false;

        if (resolvedTargets.length > 0) {
          resolvedTargets.forEach(target => {
            const job = target.job;
            const k = target.emailIndex;
            const email = job.emails[k];
            try {
              persistMatchedBounceToApplication(applicationsSheet, job, k, classification, suppressRecipient, messageId, detectedAt);
              if (suppressRecipient) persistBouncedAddress(email);
              bounceCount++;
              messagePersisted = true;
              vLog(`    - [BOUNCE TRACKER] ${classification.type} recorded for ${email} on application row ${job.rowIndex}; suppression=${suppressRecipient ? 'YES' : 'NO'}.`);
            } catch (sheetErr) {
              threadHasUnpersistedRecognizedBounce = true;
              AppLogger.error('BOUNCES', `Failed persisting bounce update for application row ${job.rowIndex}: ${sheetErr.message}`);
            }
          });

          for (let i = sentJobs.length - 1; i >= 0; i--) {
            const stillTrackable = sentJobs[i].emails.some((email, idx) => email && isBounceRecipientTrackable(sentJobs[i], idx));
            if (!stillTrackable) sentJobs.splice(i, 1);
          }
        } else {
          const extractedRecipients = authoritativeRecipients.length > 0
            ? authoritativeRecipients
            : extractBounceRecipientCandidates(searchable, config);
          messagePersisted = appendBounceAuditRecord({
            detectedAt,
            gmailMessageId: messageId,
            gmailThreadId: threadId,
            status: LOG_STATUS_BOUNCE_UNMATCHED,
            bounceType: classification.type,
            bounceCode: classification.statusCode || '',
            bounceSuppressed: 'NO',
            targetEmail: extractedRecipients.join(', '),
            subject,
            diagnostic: classification.diagnosticExcerpt || '',
            archivedAt: '',
            notes: 'Recognized delivery-status notification could not be uniquely correlated to an application recipient.'
          }, bounceAuditSheet);
          if (messagePersisted) {
            bounceCount++;
            vLog(`    - [BOUNCE TRACKER] ${classification.type} logged to Bounce Audit as BOUNCE_UNMATCHED; no unique application recipient could be correlated.`);
          } else {
            threadHasUnpersistedRecognizedBounce = true;
          }
        }

        if (messagePersisted) {
          if (messageId) {
            loggedBounceMessageIds.add(messageId);
            persistedMessageIds.push(messageId);
          }
          threadCanArchive = true;
        }
      });

      if (threadCanArchive && !threadHasUnpersistedRecognizedBounce) {
        try {
          thread.moveToArchive();
          archivedThreadCount++;
          RUN_METRICS.bouncesArchived++;
          markBounceAuditMessagesArchived(bounceAuditSheet, persistedMessageIds, getCurrentTimestampString());
          vLog(`  - [BOUNCE TRACKER] Archived fully logged bounce thread #${threadIdx + 1}.`);
        } catch (archiveErr) {
          vLog(`  - [BOUNCE TRACKER] [WARNING] Bounce thread #${threadIdx + 1} was logged but could not be archived: ${archiveErr.message}`);
        }
      }
    });

    RUN_METRICS.bouncesDetected += bounceCount;
    vLog(`  - [BOUNCE TRACKER] Scan complete. Classified/logged ${bounceCount} bounce event(s); archived ${archivedThreadCount} thread(s).`);
  } catch (e) {
    vLog(`  - [BOUNCE TRACKER] Warning: Tracking execution encountered an error: ${e.message}`);
  }
}
function extractEmailAddressFromHeader(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const angleMatch = text.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angleMatch) return sanitizeEmailAddress(angleMatch[1]);
  const bareMatch = text.match(/([a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  return bareMatch ? sanitizeEmailAddress(bareMatch[1]) : '';
}

/**
 * Validates an individual message as a delivery-status notification (DSN).
 *
 * Gmail search results are thread-scoped, so sender/subject search terms alone
 * are not sufficient: an ordinary outbound application can share a thread with
 * a DSN. Require standards-based DSN structure or a system sender plus strong
 * DSN evidence before the bounce classifier may inspect a message.
 */
function isDeliveryStatusNotificationMessage(msg, rawContent, plainBody, subjectValue) {
  if (!msg) return false;
  try {
    const from = extractEmailAddressFromHeader(msg.getFrom ? msg.getFrom() : '');
    const localPart = from ? String(from.split('@')[0] || '').toLowerCase() : '';
    const systemSender = /^(?:mailer-daemon|mail-daemon|postmaster)$/.test(localPart);
    const raw = String(rawContent || '');
    const body = String(plainBody || '');
    const subject = String(subjectValue || (msg.getSubject ? msg.getSubject() : '') || '');
    const combined = `${subject}\n${body}\n${raw}`;

    const multipartReport = /content-type\s*:\s*multipart\/report[\s\S]{0,300}?report-type\s*=\s*["']?delivery-status/i.test(raw);
    const deliveryStatusPart = /content-type\s*:\s*message\/delivery-status/i.test(raw);
    const hasRecipientField = /(?:^|\r?\n)(?:final-recipient|original-recipient)\s*:/im.test(raw);
    const hasActionField = /(?:^|\r?\n)action\s*:\s*(?:failed|delayed|expanded|relayed|delivered)\b/im.test(raw);
    const hasStatusField = /(?:^|\r?\n)status\s*:\s*[245]\.\d\.\d{1,3}\b/im.test(raw);
    const hasDiagnosticField = /(?:^|\r?\n)diagnostic-code\s*:\s*(?:smtp|x-[^;]+)\s*;/im.test(raw);
    const emptyReturnPath = /(?:^|\r?\n)return-path\s*:\s*<>\s*$/im.test(raw);
    const subjectSignal = /delivery status notification|undeliverable|mail delivery (?:failed|failure)|returned mail|delivery failure|failure notice|delivery incomplete|delivery delayed/i.test(subject);
    const bodySignal = /delivery (?:has )?failed|wasn['’]?t delivered|couldn['’]?t be found|recipient address rejected|message could not be delivered/i.test(body);
    const hasEnhancedBounceCode = /\b[45]\.\d\.\d{1,3}\b/.test(combined);

    const structuredDsn = (multipartReport || deliveryStatusPart) && hasRecipientField && (hasStatusField || hasDiagnosticField);
    const fieldRichDsn = hasRecipientField && hasActionField && hasStatusField && (hasDiagnosticField || emptyReturnPath);
    const proseSystemDsn = systemSender && subjectSignal && bodySignal && hasEnhancedBounceCode;
    const systemGeneratedDsn = systemSender && (structuredDsn || fieldRichDsn || proseSystemDsn || ((subjectSignal || bodySignal) && hasRecipientField && (hasStatusField || hasDiagnosticField)));

    return structuredDsn || fieldRichDsn || systemGeneratedDsn;
  } catch (e) {
    vLog(`    - [BOUNCE TRACKER] [WARNING] Could not validate delivery-status message: ${e.message}`);
    return false;
  }
}

// Backward-compatible alias retained for callers/tests using the older helper.
function isGmailMailDeliverySubsystemMessage(msg) {
  if (!msg) return false;
  let raw = '';
  let body = '';
  let subject = '';
  try { raw = String(msg.getRawContent ? msg.getRawContent() : ''); } catch (e) {}
  try { body = String(msg.getPlainBody ? msg.getPlainBody() : ''); } catch (e) {}
  try { subject = String(msg.getSubject ? msg.getSubject() : ''); } catch (e) {}
  return isDeliveryStatusNotificationMessage(msg, raw, body, subject);
}

function extractAuthoritativeDsnStatus(content) {
  const source = String(content || '');
  if (!source) return { statusCode: '', enhancedStatusCode: '' };

  // Prefer RFC-style delivery-status fields over arbitrary codes embedded in
  // the original message/MIME payload. A DSN's Status and Diagnostic-Code
  // describe the actual delivery result and therefore outrank broad text.
  const statusMatch = source.match(/(?:^|\r?\n)Status\s*:\s*([245]\.\d\.\d{1,3})\b/im);
  const diagnosticMatch = source.match(/(?:^|\r?\n)Diagnostic-Code\s*:\s*[^;\r\n]+;([^\r\n]*)/im);
  const diagnostic = diagnosticMatch ? String(diagnosticMatch[1] || '').trim() : '';
  const combinedMatch = diagnostic.match(/\b([245]\d{2})[\s-]+([245]\.\d\.\d{1,3})\b/i);
  const diagnosticEnhanced = diagnostic.match(/\b([245]\.\d\.\d{1,3})\b/i);
  const diagnosticSmtp = diagnostic.match(/(?:^|\s)([245]\d{2})(?:\s|$)/);

  const enhancedStatusCode = statusMatch
    ? statusMatch[1]
    : (combinedMatch ? combinedMatch[2] : (diagnosticEnhanced ? diagnosticEnhanced[1] : ''));
  const statusCode = combinedMatch
    ? `${combinedMatch[1]} ${combinedMatch[2]}`
    : (diagnosticSmtp
      ? `${diagnosticSmtp[1]}${enhancedStatusCode ? ` ${enhancedStatusCode}` : ''}`.trim()
      : enhancedStatusCode);

  return { statusCode, enhancedStatusCode };
}

function classifyGmailBounce(content) {
  const source = String(content || '');
  const text = source.toLowerCase();
  if (!text) return null;

  const authoritative = extractAuthoritativeDsnStatus(source);
  const statusCode = authoritative.statusCode || extractBounceStatusCode(text);
  const enhanced = authoritative.enhancedStatusCode || extractEnhancedStatusCode(text);
  const hasPolicySignal = /message blocked|flagged as spam|spam-like|spam detected|reputation|policy rejection|policy violation|unauthenticated|authentication required|prohibited attachment|unsolicited|dmarc|dkim|spf fail|security policy/i.test(text);

  // Specific conditions always win, even when their enhanced code belongs to
  // a broader 4.x/5.x family.
  if (/(?:helo|ehlo)/i.test(text) && (/(?:5\.5\.4|501\s+5\.5\.4)/i.test(text) || /invalid|empty|argument|hostname|identif/i.test(text))) {
    return buildBounceClassification(BOUNCE_TYPES.HELO_EHLO_ERROR, statusCode, enhanced, text);
  }

  if (/(?:reached|exceeded|hit).{0,40}(?:sending|send|message|recipient|daily|relay).{0,25}limit|limit for sending mail|too many messages|daily sending quota|5\.4\.5/i.test(text)) {
    return buildBounceClassification(BOUNCE_TYPES.SENDER_LIMIT, statusCode, enhanced, text);
  }

  if (/(?:4\.2\.2|5\.2\.2|4\.2\.1)/i.test(text) || /(?:inbox|mailbox).{0,25}(?:full|over quota)|out of storage|storage quota|receiving mail too rapidly|mailbox quota/i.test(text)) {
    return buildBounceClassification(BOUNCE_TYPES.MAILBOX_FULL, statusCode, enhanced, text);
  }

  if (/(?:5\.1\.1|5\.1\.2|5\.1\.3)/i.test(text) || /address not found|recipient address.*(?:not found|invalid|rejected)|no such user|unknown user|user unknown|mailbox unavailable|does not exist|nonexistent (?:mailbox|recipient|domain)/i.test(text) || (/(?:5\.2\.1)/i.test(text) && /inactive|disabled|not accepting|cannot receive/i.test(text))) {
    return buildBounceClassification(BOUNCE_TYPES.INVALID_RECIPIENT, statusCode, enhanced, text);
  }

  // When an RFC DSN provides an authoritative enhanced status code, let that
  // code outrank unrelated words contained in the embedded original message.
  // 4.7.x is policy/security only when the diagnostic itself carries a policy
  // signal; other 4.x.x codes are temporary delivery failures.
  if (authoritative.enhancedStatusCode) {
    if (/^4\.7\./.test(authoritative.enhancedStatusCode) && hasPolicySignal) {
      return buildBounceClassification(BOUNCE_TYPES.POLICY_SPAM_SECURITY, statusCode, enhanced, text);
    }
    if (/^4\./.test(authoritative.enhancedStatusCode)) {
      return buildBounceClassification(BOUNCE_TYPES.TEMPORARY_DELIVERY, statusCode, enhanced, text);
    }
    if (/^5\.7\./.test(authoritative.enhancedStatusCode)) {
      return buildBounceClassification(BOUNCE_TYPES.POLICY_SPAM_SECURITY, statusCode, enhanced, text);
    }
  }

  // Fallback for prose/non-structured DSNs that do not expose authoritative
  // Status/Diagnostic-Code fields.
  if (/(?:4\.7\.\d+|5\.7\.\d+)/i.test(text) || hasPolicySignal) {
    return buildBounceClassification(BOUNCE_TYPES.POLICY_SPAM_SECURITY, statusCode, enhanced, text);
  }

  if (/(?:delivery incomplete|temporary problem delivering|will retry|will keep trying|temporarily rejected|server busy|server unavailable|connection timed out|connection timeout|dns|routing trouble|throttl)/i.test(text) || /\b4\.\d\.\d+\b/i.test(text) || /\b4\d\d\b/i.test(text)) {
    return buildBounceClassification(BOUNCE_TYPES.TEMPORARY_DELIVERY, statusCode, enhanced, text);
  }

  return null;
}

function buildBounceClassification(typeDef, statusCode, enhancedStatusCode, sourceText) {
  const resolvedCode = statusCode || enhancedStatusCode || '';
  const policyPermanent = typeDef.id === BOUNCE_TYPES.POLICY_SPAM_SECURITY.id &&
    (/(?:^|\s)5\.7\./.test(String(enhancedStatusCode || resolvedCode)) || /^5\d\d\b/.test(String(resolvedCode)));
  const permanentRecipientFailure = typeDef.id === BOUNCE_TYPES.INVALID_RECIPIENT.id || policyPermanent;
  return {
    type: typeDef.id,
    label: typeDef.label,
    statusCode: resolvedCode,
    enhancedStatusCode: enhancedStatusCode || '',
    permanentRecipientFailure,
    retryable: !permanentRecipientFailure,
    diagnosticExcerpt: truncateText(oneLinePlainText(sourceText || ''), 240)
  };
}

function extractBounceStatusCode(text) {
  const source = String(text || '');
  const combined = source.match(/\b([245]\d{2})[\s-]+([245]\.\d\.\d{1,3})\b/i);
  if (combined) return `${combined[1]} ${combined[2]}`;

  const enhanced = source.match(/\b([245]\.\d\.\d{1,3})\b/i);
  if (enhanced) return enhanced[1];

  // A bare 4xx/5xx number is only a valid SMTP code when it appears in a
  // diagnostic context. This prevents unrelated numbers in subjects or normal
  // message text (for example, job IDs) from becoming bounce codes.
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    const leading = line.match(/^([245]\d{2})(?:[\s-]|$)/);
    if (leading) return leading[1];
    const contextual = line.match(/(?:diagnostic-code|smtp|remote server|server response|response was|reply|said|status)[^\r\n]{0,80}\b([245]\d{2})\b/i);
    if (contextual) return contextual[1];
  }
  return '';
}

function extractEnhancedStatusCode(text) {
  const match = String(text || '').match(/\b([245]\.\d\.\d{1,3})\b/i);
  return match ? match[1] : '';
}

function shouldSuppressBounceRecipient(classification) {
  if (!classification) return false;
  if (typeof classification.permanentRecipientFailure === 'boolean') return classification.permanentRecipientFailure;
  if (classification.type === BOUNCE_TYPES.INVALID_RECIPIENT.id) return true;
  if (classification.type !== BOUNCE_TYPES.POLICY_SPAM_SECURITY.id) return false;
  const code = String(classification.enhancedStatusCode || classification.statusCode || '');
  return /(?:^|\s)5\.7\./.test(code) || /^5\d\d\b/.test(code);
}

function isBounceRecipientTrackable(job, emailIndex) {
  if (!job) return false;
  const status = String((job.statuses && job.statuses[emailIndex]) || '').toUpperCase();
  if (status === 'SENT') return true;
  // New-format temporary/non-recipient failures stay correlatable so a later
  // final DSN can refine the type and, when appropriate, suppression.
  if (status === 'BOUNCED') {
    const suppressed = String((job.bounceSuppressed && job.bounceSuppressed[emailIndex]) || '').toUpperCase();
    return suppressed === 'NO';
  }
  return false;
}

function resolveBounceTargets(sentJobs, searchableContent, recipientHints, includeTerminalRecipients) {
  const content = String(searchableContent || '').toLowerCase();
  const hintedRecipients = new Set((recipientHints || []).map(sanitizeEmailAddress).filter(Boolean));
  const candidatesByEmail = {};

  sentJobs.forEach(job => {
    job.emails.forEach((email, emailIndex) => {
      if (!email || (!includeTerminalRecipients && !isBounceRecipientTrackable(job, emailIndex))) return;
      if (hintedRecipients.size > 0) {
        if (!hintedRecipients.has(email)) return;
      } else if (!content.includes(email)) {
        return;
      }
      if (!candidatesByEmail[email]) candidatesByEmail[email] = [];
      const strongJobMatch = Boolean(
        (job.jobId && content.includes(job.jobId)) ||
        (job.jobTitle && content.includes(job.jobTitle))
      );
      candidatesByEmail[email].push({ job, emailIndex, strongJobMatch });
    });
  });

  const resolved = [];
  Object.keys(candidatesByEmail).forEach(email => {
    const candidates = candidatesByEmail[email];
    const strong = candidates.filter(c => c.strongJobMatch);
    if (strong.length === 1) {
      resolved.push(strong[0]);
    } else if (strong.length === 0 && candidates.length === 1) {
      resolved.push(candidates[0]);
    } else if (strong.length > 1) {
      vLog(`    - [BOUNCE TRACKER] [WARNING] Ambiguous strong match for ${email}; refusing to guess among ${strong.length} application rows.`);
    } else {
      vLog(`    - [BOUNCE TRACKER] [WARNING] ${email} maps to ${candidates.length} candidate application rows without a unique Job ID/title match.`);
    }
  });
  return resolved;
}

function extractBounceRecipientCandidates(content, config) {
  const text = String(content || '');
  const out = new Set();
  let match;

  // Prefer explicit DSN recipient fields. These are authoritative and avoid
  // collecting sender, DKIM, relay, and Google infrastructure addresses.
  const dsnHeaderPatterns = [
    /(?:final-recipient|original-recipient)\s*:\s*(?:rfc822\s*;\s*)?([^\s<>;,]+)/gi,
    /(?:x-failed-recipients|failed-recipient)\s*:\s*([^\s<>;,]+)/gi
  ];
  dsnHeaderPatterns.forEach(pattern => {
    while ((match = pattern.exec(text)) !== null) {
      const email = sanitizeEmailAddress(match[1]);
      if (isProbableBounceRecipientCandidate(email, config)) out.add(email);
    }
  });

  // Gmail's human-readable DSNs often name the failed recipient directly.
  const prosePatterns = [
    /(?:delivered|delivering|delivery|message)\s+(?:to|for)\s+([a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})/gi,
    /(?:recipient|address|mailbox)\s*[:=]?\s*<?([a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})>?/gi,
    /(?:couldn't|could not|wasn't|was not|unable to)\s+(?:be\s+)?delivered\s+to\s+([a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})/gi
  ];
  prosePatterns.forEach(pattern => {
    while ((match = pattern.exec(text)) !== null) {
      const email = sanitizeEmailAddress(match[1]);
      if (isProbableBounceRecipientCandidate(email, config)) out.add(email);
    }
  });

  // Only if DSN-specific fields yielded nothing, use a tightly filtered email
  // fallback. This keeps BOUNCE_UNMATCHED useful without exposing MIME-routing
  // addresses as if they were failed recipients.
  if (out.size === 0) {
    const emailRegex = /[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
    while ((match = emailRegex.exec(text)) !== null) {
      const email = sanitizeEmailAddress(match[0]);
      if (isProbableBounceRecipientCandidate(email, config)) out.add(email);
    }
  }
  return Array.from(out).slice(0, 10);
}

function isProbableBounceRecipientCandidate(email, config) {
  const normalized = sanitizeEmailAddress(email);
  if (!normalized || !isValidEmailAddress(normalized)) return false;
  if (normalized === 'mailer-daemon@googlemail.com') return false;

  const parts = normalized.split('@');
  const localPart = parts[0] || '';
  const domain = parts[1] || '';
  if (!localPart || !domain) return false;
  if (/^(?:postmaster|mailer-daemon|daemon|header\.i=?)$/i.test(localPart)) return false;
  if (/^header\.i=/i.test(localPart)) return false;
  if (domain === 'mail.gmail.com' || domain === 'mx.google.com' || domain.endsWith('.mx.google.com')) return false;

  const ownAddresses = getBounceOwnAddressSet(config);
  return !ownAddresses.has(normalized);
}

function getBounceOwnAddressSet(config) {
  const ownAddresses = new Set();
  const configured = sanitizeEmailAddress(config && config.applicantEmail);
  if (configured) ownAddresses.add(configured);

  if (CACHED_EFFECTIVE_USER_EMAIL === null) {
    try {
      CACHED_EFFECTIVE_USER_EMAIL = sanitizeEmailAddress(Session.getEffectiveUser().getEmail());
    } catch (e) {
      CACHED_EFFECTIVE_USER_EMAIL = '';
    }
  }
  if (CACHED_EFFECTIVE_USER_EMAIL) ownAddresses.add(CACHED_EFFECTIVE_USER_EMAIL);

  getNormalizedGmailAliases().forEach(alias => {
    const clean = sanitizeEmailAddress(alias);
    if (clean) ownAddresses.add(clean);
  });
  return ownAddresses;
}

function splitAlignedCsv(value) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) return [];
  return text.split(',').map(v => String(v || '').trim());
}

function alignArrayToLength(values, length) {
  const out = Array.isArray(values) ? values.slice(0, length) : [];
  while (out.length < length) out.push('');
  return out;
}

function sanitizeAlignedCsvField(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').replace(/,/g, ';').trim();
}

/**
 * Hydrates suppression memory from historical sheet rows. New-format rows use the
 * explicit Bounce Suppressed column; legacy BOUNCED rows retain prior behavior.
 */
function syncBouncedAddressesFromSheet(config) {
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) return;

  try {
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetLogId);
    const sheet = getOrCreateApplicationsSheet(spreadsheet);
    const headerMap = getSheetHeaderMap(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;

    const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const addressesToPersist = new Set();
    rows.forEach(row => {
      for (let slot = 1; slot <= MAX_APPLICATION_RECIPIENT_SLOTS; slot++) {
        const email = sanitizeEmailAddress(getApplicationRowValue(row, headerMap, `Recipient ${slot} Email`));
        const suppressed = String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Suppressed`) || '').toUpperCase();
        if (email && suppressed === 'YES') addressesToPersist.add(email);
      }
    });

    if (addressesToPersist.size > 0) {
      persistBouncedAddresses(Array.from(addressesToPersist));
      vLog(`  - [BOUNCE SUPPRESSION] Hydrated ${addressesToPersist.size} unique permanently suppressed target(s) from Applications.`);
    }
  } catch (e) {
    vLog(`  - [BOUNCE SUPPRESSION] Warning: Could not hydrate Applications bounce suppression data: ${e.message}`);
  }
}

function getOrCreateApplicationsSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(APPLICATIONS_SHEET_NAME);
  if (sheet && !isApplicationsSheetSchema(sheet)) {
    const legacyName = getUniqueSheetName(spreadsheet, 'Legacy Log');
    sheet.setName(legacyName);
    vLog(`[SHEET LOG] Existing sheet named "${APPLICATIONS_SHEET_NAME}" used the legacy schema and was preserved as "${legacyName}".`);
    sheet = null;
  }

  if (!sheet) {
    sheet = spreadsheet.insertSheet(APPLICATIONS_SHEET_NAME);
  }
  ensureApplicationsSheetSchema(sheet);

  // Reconcile once per execution even when Applications already contains data.
  // This makes the one-row model self-healing if an earlier migration/upsert
  // omitted legacy positions; existing Applications rows are never overwritten.
  if (!APPLICATION_RECONCILIATION_COMPLETED) {
    migrateLegacySpreadsheetLogIfNeeded(spreadsheet, sheet);
    APPLICATION_RECONCILIATION_COMPLETED = true;
  }
  return sheet;
}

function getOrCreateBounceAuditSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(BOUNCE_AUDIT_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(BOUNCE_AUDIT_SHEET_NAME);
  ensureBounceAuditSheetSchema(sheet);
  return sheet;
}

function getUniqueSheetName(spreadsheet, baseName) {
  if (!spreadsheet.getSheetByName(baseName)) return baseName;
  let suffix = 2;
  while (spreadsheet.getSheetByName(`${baseName} ${suffix}`)) suffix++;
  return `${baseName} ${suffix}`;
}

function isApplicationsSheetSchema(sheet) {
  if (!sheet || sheet.getLastRow() === 0 || sheet.getLastColumn() < 8) return false;
  const headers = sheet.getRange(1, 1, 1, 8).getValues()[0].map(v => String(v || '').trim());
  return headers[0] === 'Created At' && headers[3] === 'Job ID' && headers[7] === 'Core Status';
}

function isLegacySpreadsheetLogSheet(sheet) {
  if (!sheet || sheet.getLastRow() === 0 || sheet.getLastColumn() < 10) return false;
  const headers = sheet.getRange(1, 1, 1, 10).getValues()[0].map(v => String(v || '').trim());
  return LEGACY_SPREADSHEET_LOG_HEADERS.slice(0, 10).every((header, idx) => headers[idx] === header);
}

function ensureApplicationsSheetSchema(sheet) {
  if (!sheet) throw new Error('Applications sheet is required.');
  const requiredColumns = APPLICATIONS_SHEET_HEADERS.length;
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, requiredColumns).setValues([APPLICATIONS_SHEET_HEADERS.slice()]).setFontWeight('bold');
    return;
  }

  const current = sheet.getRange(1, 1, 1, requiredColumns).getValues()[0];
  const filled = current.slice();
  APPLICATIONS_SHEET_HEADERS.forEach((header, idx) => {
    const actual = String(current[idx] || '').trim();
    if (!actual) filled[idx] = header;
    else if (actual !== header) {
      throw new Error(`Applications schema mismatch at column ${idx + 1}: found "${actual}", expected "${header}".`);
    }
  });
  if (filled.some((v, idx) => v !== current[idx])) {
    sheet.getRange(1, 1, 1, requiredColumns).setValues([filled]).setFontWeight('bold');
  }
}

function ensureBounceAuditSheetSchema(sheet) {
  if (!sheet) throw new Error('Bounce Audit sheet is required.');
  const requiredColumns = BOUNCE_AUDIT_HEADERS.length;
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, requiredColumns).setValues([BOUNCE_AUDIT_HEADERS.slice()]).setFontWeight('bold');
    return;
  }
  const current = sheet.getRange(1, 1, 1, requiredColumns).getValues()[0];
  const filled = current.slice();
  BOUNCE_AUDIT_HEADERS.forEach((header, idx) => {
    const actual = String(current[idx] || '').trim();
    if (!actual) filled[idx] = header;
    else if (actual !== header) throw new Error(`Bounce Audit schema mismatch at column ${idx + 1}: found "${actual}", expected "${header}".`);
  });
  if (filled.some((v, idx) => v !== current[idx])) {
    sheet.getRange(1, 1, 1, requiredColumns).setValues([filled]).setFontWeight('bold');
  }
}

function getSheetHeaderMap(sheet) {
  const lastColumn = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const map = {};
  headers.forEach((header, idx) => {
    const key = String(header || '').trim();
    if (key) map[key] = idx;
  });
  return map;
}

function getApplicationRowValue(row, headerMap, header) {
  const idx = headerMap[header];
  return typeof idx === 'number' ? row[idx] : '';
}

function setApplicationRowValue(row, headerMap, header, value) {
  const idx = headerMap[header];
  if (typeof idx === 'number') row[idx] = value == null ? '' : value;
}

function normalizeSheetTimestamp(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value || '').trim();
}

function appendApplicationNote(row, headerMap, note) {
  const clean = String(note || '').trim();
  if (!clean) return;
  const existing = String(getApplicationRowValue(row, headerMap, 'Notes') || '').trim();
  if (!existing) setApplicationRowValue(row, headerMap, 'Notes', clean);
  else if (!existing.includes(clean)) setApplicationRowValue(row, headerMap, 'Notes', `${existing} | ${clean}`);
}

function findApplicationRowIndex(sheet, headerMap, jobId, sourceFileName) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  if (jobId && typeof headerMap['Job ID'] === 'number') {
    const values = sheet.getRange(2, headerMap['Job ID'] + 1, lastRow - 1, 1).getValues();
    const target = String(jobId).trim().toLowerCase();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim().toLowerCase() === target) return i + 2;
    }
  }
  if (!jobId && sourceFileName && typeof headerMap['Source File Name'] === 'number') {
    const values = sheet.getRange(2, headerMap['Source File Name'] + 1, lastRow - 1, 1).getValues();
    const target = String(sourceFileName).trim().toLowerCase();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim().toLowerCase() === target) return i + 2;
    }
  }
  return 0;
}

function getRecipientSlotForEmail(row, headerMap, email, allocateIfMissing) {
  const normalized = sanitizeEmailAddress(email);
  if (!normalized) return 0;
  let firstEmpty = 0;
  for (let slot = 1; slot <= MAX_APPLICATION_RECIPIENT_SLOTS; slot++) {
    const existing = sanitizeEmailAddress(getApplicationRowValue(row, headerMap, `Recipient ${slot} Email`));
    if (existing === normalized) return slot;
    if (!existing && !firstEmpty) firstEmpty = slot;
  }
  return allocateIfMissing ? firstEmpty : 0;
}

function expandAlignedValues(values, length) {
  const source = Array.isArray(values) ? values.slice() : [];
  if (source.length === 1 && length > 1) return Array(length).fill(source[0]);
  return alignArrayToLength(source, length);
}

function upsertRecipientFields(row, headerMap, params, deliveryStatuses) {
  const emails = splitAlignedCsv(params.targetEmail).map(e => sanitizeEmailAddress(e)).filter(Boolean);
  if (!emails.length) return;
  const tiers = expandAlignedValues(splitAlignedCsv(params.emailTier), emails.length);
  const messages = expandAlignedValues(splitAlignedCsv(params.messageId), emails.length);
  const recipientScores = Array.isArray(params.recipientScores)
    ? expandAlignedValues(params.recipientScores.map(v => String(v == null ? '' : v)), emails.length)
    : Array(emails.length).fill(params.score || '');
  const statuses = deliveryStatuses ? expandAlignedValues(deliveryStatuses, emails.length) : [];

  emails.forEach((email, idx) => {
    const slot = getRecipientSlotForEmail(row, headerMap, email, true);
    if (!slot) {
      appendApplicationNote(row, headerMap, `Recipient capacity exceeded; could not store ${email}.`);
      return;
    }
    setApplicationRowValue(row, headerMap, `Recipient ${slot} Email`, email);
    const tier = String(tiers[idx] || '').trim();
    if (tier && !/^(CORE|RENDER|BOUNCE|DUPLICATE)$/i.test(tier)) setApplicationRowValue(row, headerMap, `Recipient ${slot} Tier`, tier);
    if (recipientScores[idx] !== '') setApplicationRowValue(row, headerMap, `Recipient ${slot} Score`, recipientScores[idx]);
    if (statuses.length && statuses[idx]) setApplicationRowValue(row, headerMap, `Recipient ${slot} Delivery Status`, statuses[idx]);
    if (messages[idx]) setApplicationRowValue(row, headerMap, `Recipient ${slot} Message ID`, messages[idx]);
  });
}

function deriveDispatchStatusFromApplicationRow(row, headerMap) {
  const statuses = [];
  for (let slot = 1; slot <= MAX_APPLICATION_RECIPIENT_SLOTS; slot++) {
    const email = sanitizeEmailAddress(getApplicationRowValue(row, headerMap, `Recipient ${slot} Email`));
    const status = String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Delivery Status`) || '').trim().toUpperCase();
    if (email && status) statuses.push(status);
  }
  if (!statuses.length) return '';
  const unique = Array.from(new Set(statuses));
  if (unique.length === 1) return unique[0];
  return LOG_STATUS_PARTIAL_DELIVERY;
}

function applicationErrorText(messageId) {
  return String(messageId || '').replace(/^ERROR:\s*/i, '').trim();
}

function applyApplicationParamsToRow(row, headerMap, params, timestampOverride) {
  const now = timestampOverride || getCurrentTimestampString();
  if (!getApplicationRowValue(row, headerMap, 'Created At')) setApplicationRowValue(row, headerMap, 'Created At', now);
  setApplicationRowValue(row, headerMap, 'Updated At', now);
  if (params.company) setApplicationRowValue(row, headerMap, 'Company', params.company);
  if (params.jobId) setApplicationRowValue(row, headerMap, 'Job ID', params.jobId);
  if (params.jobTitle) setApplicationRowValue(row, headerMap, 'Job Title', params.jobTitle);
  if (params.jobUrl) setApplicationRowValue(row, headerMap, 'Job URL', params.jobUrl);
  if (params.companyAddress) setApplicationRowValue(row, headerMap, 'Company Address', params.companyAddress);
  if (params.score !== undefined && params.score !== '') setApplicationRowValue(row, headerMap, 'Discovery Score', params.score);
  if (params.sourceFileName && String(params.status || '').toUpperCase() !== LOG_STATUS_DUPLICATE) setApplicationRowValue(row, headerMap, 'Source File Name', params.sourceFileName);
  setApplicationRowValue(row, headerMap, 'Last Run ID', RUN_METRICS.runId);

  const statusText = String(params.status || 'UNKNOWN').trim();
  const statusUpper = statusText.toUpperCase();

  if (statusUpper === LOG_STATUS_INGEST_PARSE_FAILED || statusUpper === LOG_STATUS_DOCGEN_FAILED) {
    setApplicationRowValue(row, headerMap, 'Core Status', statusUpper);
    setApplicationRowValue(row, headerMap, 'Core Error', applicationErrorText(params.messageId));
    upsertRecipientFields(row, headerMap, params, null);
    return;
  }

  if (statusUpper === LOG_STATUS_CORE_PROCESSED) {
    setApplicationRowValue(row, headerMap, 'Core Status', LOG_STATUS_CORE_PROCESSED);
    setApplicationRowValue(row, headerMap, 'Core Completed At', now);
    setApplicationRowValue(row, headerMap, 'Core Error', '');
    upsertRecipientFields(row, headerMap, params, null);
    return;
  }

  if (statusUpper === LOG_STATUS_DUPLICATE) {
    const count = Number(getApplicationRowValue(row, headerMap, 'Duplicate Count') || 0) + 1;
    setApplicationRowValue(row, headerMap, 'Duplicate Count', count);
    setApplicationRowValue(row, headerMap, 'Last Duplicate Detected At', now);
    appendApplicationNote(row, headerMap, params.messageId || 'Duplicate source material detected.');
    return;
  }

  if (statusUpper === LOG_STATUS_RENDER_COMPLETE || statusUpper === LOG_STATUS_RENDER_DISABLED || statusUpper === LOG_STATUS_RENDER_FAILED) {
    setApplicationRowValue(row, headerMap, 'Render Status', statusUpper);
    setApplicationRowValue(row, headerMap, 'Render Completed At', now);
    setApplicationRowValue(row, headerMap, 'Render Error', statusUpper === LOG_STATUS_RENDER_FAILED ? applicationErrorText(params.messageId) : '');
    return;
  }

  const directDispatchStatuses = new Set([
    LOG_STATUS_NO_DRAFTABLE_ROUTE, LOG_STATUS_DISPATCH_DISABLED, LOG_STATUS_DISPATCH_FAILED,
    LOG_STATUS_SUPPRESSED_BOUNCE, 'SENT', 'DRAFTED', 'BOUNCED', LOG_STATUS_PARTIAL_DELIVERY
  ]);
  const statusParts = splitAlignedCsv(statusUpper);
  const isDispatch = statusParts.some(s => directDispatchStatuses.has(s));
  if (isDispatch) {
    upsertRecipientFields(row, headerMap, params, statusParts);
    let derived = deriveDispatchStatusFromApplicationRow(row, headerMap);
    if (!derived && statusParts.length === 1) derived = statusParts[0];
    setApplicationRowValue(row, headerMap, 'Dispatch Status', derived || statusUpper);
    setApplicationRowValue(row, headerMap, 'Dispatch Completed At', now);
    if (statusParts.includes(LOG_STATUS_DISPATCH_FAILED)) {
      const emails = splitAlignedCsv(params.targetEmail).map(e => sanitizeEmailAddress(e)).filter(Boolean);
      const alignedStatuses = expandAlignedValues(statusParts, emails.length || statusParts.length);
      const alignedMessages = expandAlignedValues(splitAlignedCsv(params.messageId), emails.length || statusParts.length);
      const errors = alignedStatuses.map((status, idx) => status === LOG_STATUS_DISPATCH_FAILED ? applicationErrorText(alignedMessages[idx]) : '').filter(Boolean);
      setApplicationRowValue(row, headerMap, 'Dispatch Error', errors.join(' | '));
    } else {
      setApplicationRowValue(row, headerMap, 'Dispatch Error', '');
    }
    return;
  }

  appendApplicationNote(row, headerMap, `Unrecognized stage status: ${statusText}`);
}

function upsertApplicationRecordOnSheet(sheet, params, timestampOverride) {
  ensureApplicationsSheetSchema(sheet);
  const headerMap = getSheetHeaderMap(sheet);
  const sourceKey = params.sourceFileName || ((params.status === LOG_STATUS_INGEST_PARSE_FAILED && !params.jobId) ? params.jobTitle : '');
  let rowIndex = findApplicationRowIndex(sheet, headerMap, params.jobId, sourceKey);
  const lastColumn = sheet.getLastColumn();
  let row = rowIndex ? sheet.getRange(rowIndex, 1, 1, lastColumn).getValues()[0] : Array(lastColumn).fill('');
  applyApplicationParamsToRow(row, headerMap, params, timestampOverride);
  if (!rowIndex) rowIndex = sheet.getLastRow() + 1;
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  vLog(`[SHEET LOG] Upserted Applications row ${rowIndex} | core=${getApplicationRowValue(row, headerMap, 'Core Status') || ''} dispatch=${getApplicationRowValue(row, headerMap, 'Dispatch Status') || ''} company="${params.company || ''}" jobId="${params.jobId || ''}"`);
  return true;
}

function ensureCustomApplicationHeaders(applicationsSheet, customHeaders) {
  const cleanHeaders = (customHeaders || []).map(v => String(v || '').trim()).filter(Boolean);
  if (!cleanHeaders.length) return;
  let headers = applicationsSheet.getRange(1, 1, 1, applicationsSheet.getLastColumn()).getValues()[0].map(v => String(v || '').trim());
  cleanHeaders.forEach(header => {
    if (headers.includes(header)) return;
    const col = headers.length + 1;
    if (applicationsSheet.getMaxColumns() < col) applicationsSheet.insertColumnsAfter(applicationsSheet.getMaxColumns(), col - applicationsSheet.getMaxColumns());
    applicationsSheet.getRange(1, col).setValue(header).setFontWeight('bold');
    headers.push(header);
  });
}

function migrateLegacySpreadsheetLogIfNeeded(spreadsheet, applicationsSheet) {
  const legacySheet = spreadsheet.getSheets().find(sheet =>
    sheet.getName() !== APPLICATIONS_SHEET_NAME &&
    sheet.getName() !== BOUNCE_AUDIT_SHEET_NAME &&
    isLegacySpreadsheetLogSheet(sheet)
  );
  if (!legacySheet || legacySheet.getLastRow() <= 1) return { addedApplications: 0, migratedBounceAudits: 0 };

  const wasEmpty = applicationsSheet.getLastRow() <= 1;
  const legacyLastColumn = legacySheet.getLastColumn();
  const legacyHeaders = legacySheet.getRange(1, 1, 1, legacyLastColumn).getValues()[0].map(v => String(v || '').trim());
  const customHeaders = legacyHeaders.slice(LEGACY_SPREADSHEET_LOG_HEADERS.length).filter(Boolean);
  ensureCustomApplicationHeaders(applicationsSheet, customHeaders);
  const appHeaders = applicationsSheet.getRange(1, 1, 1, applicationsSheet.getLastColumn()).getValues()[0].map(v => String(v || '').trim());
  const appHeaderMap = {};
  appHeaders.forEach((h, i) => { if (h) appHeaderMap[h] = i; });

  const values = legacySheet.getRange(2, 1, legacySheet.getLastRow() - 1, legacyLastColumn).getValues();
  const groups = new Map();
  const groupOrder = [];
  const bounceAuditRows = [];

  values.forEach((legacyRow, rowOffset) => {
    const timestamp = normalizeSheetTimestamp(legacyRow[0]) || getCurrentTimestampString();
    const status = String(legacyRow[1] || '').trim();
    const company = String(legacyRow[2] || '').trim();
    const jobId = String(legacyRow[3] || '').trim();
    const jobTitle = String(legacyRow[4] || '').trim();
    const targetEmail = String(legacyRow[5] || '').trim();
    const emailTier = String(legacyRow[6] || '').trim();
    const score = legacyRow[7] == null ? '' : legacyRow[7];
    const messageId = String(legacyRow[8] || '').trim();
    const jobUrl = String(legacyRow[9] || '').trim();
    const bounceType = String(legacyRow[10] || '').trim();
    const bounceCode = String(legacyRow[11] || '').trim();
    const bounceSuppressed = String(legacyRow[12] || '').trim();
    const bounceMessageId = String(legacyRow[13] || '').trim();
    const bounceDetectedAt = normalizeSheetTimestamp(legacyRow[14]);

    if (status.toUpperCase() === LOG_STATUS_BOUNCE_UNMATCHED) {
      bounceAuditRows.push({
        detectedAt: bounceDetectedAt || timestamp,
        gmailMessageId: bounceMessageId,
        gmailThreadId: '',
        status: LOG_STATUS_BOUNCE_UNMATCHED,
        bounceType,
        bounceCode,
        bounceSuppressed: bounceSuppressed || 'NO',
        targetEmail,
        subject: jobTitle || 'Migrated unmatched bounce',
        diagnostic: '',
        archivedAt: '',
        notes: `Migrated from legacy sheet "${legacySheet.getName()}" row ${rowOffset + 2}.`
      });
      return;
    }

    const sourceFileName = !jobId && status.toUpperCase() === LOG_STATUS_INGEST_PARSE_FAILED ? jobTitle : '';
    const key = jobId ? `JOB:${jobId.toLowerCase()}` : `FILE:${(sourceFileName || jobTitle || rowOffset).toString().toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, Array(appHeaders.length).fill(''));
      groupOrder.push(key);
    }
    const row = groups.get(key);
    applyApplicationParamsToRow(row, appHeaderMap, {
      status, company, jobId, jobTitle, targetEmail, emailTier, score, messageId, jobUrl, sourceFileName
    }, timestamp);

    const emails = splitAlignedCsv(targetEmail).map(e => sanitizeEmailAddress(e)).filter(Boolean);
    const bounceTypes = expandAlignedValues(splitAlignedCsv(bounceType), emails.length);
    const bounceCodes = expandAlignedValues(splitAlignedCsv(bounceCode), emails.length);
    const bounceFlags = expandAlignedValues(splitAlignedCsv(bounceSuppressed), emails.length);
    const bounceIds = expandAlignedValues(splitAlignedCsv(bounceMessageId), emails.length);
    const bounceTimes = expandAlignedValues(splitAlignedCsv(bounceDetectedAt), emails.length);
    emails.forEach((email, idx) => {
      const slot = getRecipientSlotForEmail(row, appHeaderMap, email, true);
      if (!slot) return;
      if (bounceTypes[idx]) setApplicationRowValue(row, appHeaderMap, `Recipient ${slot} Bounce Type`, bounceTypes[idx]);
      if (bounceCodes[idx]) setApplicationRowValue(row, appHeaderMap, `Recipient ${slot} Bounce Code`, bounceCodes[idx]);
      let flag = bounceFlags[idx];
      const deliveryStatus = String(getApplicationRowValue(row, appHeaderMap, `Recipient ${slot} Delivery Status`) || '').toUpperCase();
      if (!flag && deliveryStatus === 'BOUNCED') flag = 'YES';
      if (flag) setApplicationRowValue(row, appHeaderMap, `Recipient ${slot} Bounce Suppressed`, flag);
      if (bounceIds[idx]) setApplicationRowValue(row, appHeaderMap, `Recipient ${slot} Bounce Message ID`, bounceIds[idx]);
      if (bounceTimes[idx]) setApplicationRowValue(row, appHeaderMap, `Recipient ${slot} Bounce Detected At`, bounceTimes[idx]);
    });

    customHeaders.forEach((header, customIdx) => {
      const legacyValue = legacyRow[LEGACY_SPREADSHEET_LOG_HEADERS.length + customIdx];
      if (legacyValue !== '' && legacyValue != null && typeof appHeaderMap[header] === 'number') row[appHeaderMap[header]] = legacyValue;
    });
    appendApplicationNote(row, appHeaderMap, `Migrated from legacy sheet "${legacySheet.getName()}".`);
  });

  groupOrder.forEach(key => {
    const row = groups.get(key);
    const coreStatus = String(getApplicationRowValue(row, appHeaderMap, 'Core Status') || '').toUpperCase();
    if (!coreStatus) {
      const dispatchStatus = String(getApplicationRowValue(row, appHeaderMap, 'Dispatch Status') || '').toUpperCase();
      const safeLegacyCoreEvidence = new Set(['SENT', 'DRAFTED', 'BOUNCED', LOG_STATUS_PARTIAL_DELIVERY]);
      if (safeLegacyCoreEvidence.has(dispatchStatus)) {
        setApplicationRowValue(row, appHeaderMap, 'Core Status', LOG_STATUS_CORE_PROCESSED);
        setApplicationRowValue(row, appHeaderMap, 'Core Completed At', getApplicationRowValue(row, appHeaderMap, 'Updated At'));
      }
    }
  });

  // Build a durable identity set from Applications and only append missing
  // legacy records. Never overwrite a newer Applications row with old data.
  const existingKeys = new Set();
  if (applicationsSheet.getLastRow() > 1) {
    const existingRows = applicationsSheet.getRange(2, 1, applicationsSheet.getLastRow() - 1, applicationsSheet.getLastColumn()).getValues();
    existingRows.forEach((row, idx) => {
      const jobId = String(getApplicationRowValue(row, appHeaderMap, 'Job ID') || '').trim();
      const sourceFileName = String(getApplicationRowValue(row, appHeaderMap, 'Source File Name') || '').trim();
      const jobTitle = String(getApplicationRowValue(row, appHeaderMap, 'Job Title') || '').trim();
      if (jobId) existingKeys.add(`JOB:${jobId.toLowerCase()}`);
      else if (sourceFileName || jobTitle) existingKeys.add(`FILE:${(sourceFileName || jobTitle || idx).toLowerCase()}`);
    });
  }

  const missingKeys = groupOrder.filter(key => !existingKeys.has(key));
  if (missingKeys.length) {
    applicationsSheet.getRange(applicationsSheet.getLastRow() + 1, 1, missingKeys.length, appHeaders.length)
      .setValues(missingKeys.map(key => groups.get(key)));
  }

  let migratedBounceAudits = 0;
  // Historical unmatched events are copied on first migration. Subsequent
  // reconciliation passes focus on missing application rows; this avoids
  // repeatedly reproducing legacy audit entries that have no message ID.
  if (wasEmpty && bounceAuditRows.length) {
    const auditSheet = getOrCreateBounceAuditSheet(spreadsheet);
    bounceAuditRows.forEach(params => {
      if (appendBounceAuditRecord(params, auditSheet)) migratedBounceAudits++;
    });
  }

  if (wasEmpty) {
    vLog(`[SHEET LOG] Migrated ${missingKeys.length} application record(s) and ${migratedBounceAudits} unmatched bounce audit event(s) from legacy sheet "${legacySheet.getName()}". Legacy data was left untouched.`);
  } else if (missingKeys.length) {
    vLog(`[SHEET LOG] Reconciled ${missingKeys.length} missing application record(s) from legacy sheet "${legacySheet.getName()}". Existing Applications rows were left unchanged.`);
  }
  return { addedApplications: missingKeys.length, migratedBounceAudits };
}

function loadBounceTrackingJobs(sheet, includeTerminalRecipients) {
  ensureApplicationsSheetSchema(sheet);
  const headerMap = getSheetHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const jobs = [];
  rows.forEach((row, idx) => {
    const job = {
      rowIndex: idx + 2,
      rowValues: row,
      headerMap,
      jobId: String(getApplicationRowValue(row, headerMap, 'Job ID') || '').trim().toLowerCase(),
      jobTitle: String(getApplicationRowValue(row, headerMap, 'Job Title') || '').trim().toLowerCase(),
      emails: [], statuses: [], bounceTypes: [], bounceCodes: [], bounceSuppressed: [], bounceMessageIds: [], bounceDetectedAt: []
    };
    for (let slot = 1; slot <= MAX_APPLICATION_RECIPIENT_SLOTS; slot++) {
      job.emails.push(sanitizeEmailAddress(getApplicationRowValue(row, headerMap, `Recipient ${slot} Email`)));
      job.statuses.push(String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Delivery Status`) || '').trim().toUpperCase());
      job.bounceTypes.push(String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Type`) || '').trim());
      job.bounceCodes.push(String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Code`) || '').trim());
      job.bounceSuppressed.push(String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Suppressed`) || '').trim());
      job.bounceMessageIds.push(String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Message ID`) || '').trim());
      job.bounceDetectedAt.push(String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Detected At`) || '').trim());
    }
    if (job.emails.some((email, emailIdx) => email && (includeTerminalRecipients || isBounceRecipientTrackable(job, emailIdx)))) jobs.push(job);
  });
  return jobs;
}

/**
 * Self-heals historical false-positive policy labels when an authoritative
 * enhanced status code is a non-policy temporary 4.x.x result (for example
 * 4.4.1). This keeps already-archived audit evidence accurate without needing
 * the Gmail message to be re-opened. 4.7.x is deliberately excluded because
 * it can legitimately represent temporary policy/security enforcement.
 */
function normalizeHistoricalTemporaryBounceClassifications(applicationsSheet, bounceAuditSheet) {
  let applicationCorrections = 0;
  let auditCorrections = 0;

  if (applicationsSheet && applicationsSheet.getLastRow() > 1) {
    const headerMap = getSheetHeaderMap(applicationsSheet);
    const rowCount = applicationsSheet.getLastRow() - 1;
    const colCount = applicationsSheet.getLastColumn();
    const rows = applicationsSheet.getRange(2, 1, rowCount, colCount).getValues();
    let changed = false;

    rows.forEach(row => {
      let rowChanged = false;
      for (let slot = 1; slot <= MAX_APPLICATION_RECIPIENT_SLOTS; slot++) {
        const typeHeader = `Recipient ${slot} Bounce Type`;
        const codeHeader = `Recipient ${slot} Bounce Code`;
        const suppressedHeader = `Recipient ${slot} Bounce Suppressed`;
        const type = String(getApplicationRowValue(row, headerMap, typeHeader) || '').trim().toUpperCase();
        const code = String(getApplicationRowValue(row, headerMap, codeHeader) || '').trim();
        const enhanced = extractEnhancedStatusCode(code);
        if (type !== BOUNCE_TYPES.POLICY_SPAM_SECURITY.id || !/^4\.(?!7\.)/.test(enhanced)) continue;

        setApplicationRowValue(row, headerMap, typeHeader, BOUNCE_TYPES.TEMPORARY_DELIVERY.id);
        setApplicationRowValue(row, headerMap, suppressedHeader, 'NO');
        rowChanged = true;
        applicationCorrections++;
      }
      if (rowChanged) {
        setApplicationRowValue(row, headerMap, 'Updated At', getCurrentTimestampString());
        changed = true;
      }
    });

    if (changed) applicationsSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  if (bounceAuditSheet && bounceAuditSheet.getLastRow() > 1) {
    const headerMap = getSheetHeaderMap(bounceAuditSheet);
    const rows = bounceAuditSheet.getRange(2, 1, bounceAuditSheet.getLastRow() - 1, bounceAuditSheet.getLastColumn()).getValues();
    let changed = false;

    rows.forEach(row => {
      const type = String(row[headerMap['Bounce Type']] || '').trim().toUpperCase();
      const code = String(row[headerMap['Bounce Code']] || '').trim();
      const enhanced = extractEnhancedStatusCode(code);
      if (type !== BOUNCE_TYPES.POLICY_SPAM_SECURITY.id || !/^4\.(?!7\.)/.test(enhanced)) return;

      row[headerMap['Bounce Type']] = BOUNCE_TYPES.TEMPORARY_DELIVERY.id;
      row[headerMap['Bounce Suppressed']] = 'NO';
      if (typeof headerMap['Notes'] === 'number') {
        const correctionNote = `Classification normalized from POLICY_SPAM_SECURITY to TEMPORARY_DELIVERY based on authoritative ${enhanced} status.`;
        const existing = String(row[headerMap['Notes']] || '').trim();
        if (!existing.includes(correctionNote)) row[headerMap['Notes']] = existing ? `${existing} | ${correctionNote}` : correctionNote;
      }
      changed = true;
      auditCorrections++;
    });

    if (changed) bounceAuditSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  const total = applicationCorrections + auditCorrections;
  if (total > 0) {
    vLog(`[BOUNCE TRACKER] Normalized ${total} historical temporary bounce classification(s) (${applicationCorrections} Applications; ${auditCorrections} Bounce Audit).`);
  }
  return total;
}

function getBounceTypeDefinitionById(typeId) {
  const target = String(typeId || '').trim().toUpperCase();
  return Object.values(BOUNCE_TYPES).find(def => def.id === target) || null;
}

function buildBounceClassificationFromAuditRow(typeId, bounceCode, diagnostic) {
  const typeDef = getBounceTypeDefinitionById(typeId);
  if (!typeDef) return null;
  const code = String(bounceCode || '').trim();
  const diagnosticText = String(diagnostic || '').trim();
  return buildBounceClassification(typeDef, code, extractEnhancedStatusCode(`${code}\n${diagnosticText}`), `${code}\n${diagnosticText}`);
}

/**
 * Replays unresolved Bounce Audit events after Applications reconciliation.
 * A previously unmatched DSN can become safely correlatable when its legacy
 * application row is restored. Reconciliation mutates the application row,
 * marks the audit event BOUNCE_RECONCILED, and never requires Gmail re-scan.
 */
function reconcileBounceAuditEvents(applicationsSheet, bounceAuditSheet) {
  if (!applicationsSheet || !bounceAuditSheet || bounceAuditSheet.getLastRow() <= 1) return 0;

  const auditHeaderMap = getSheetHeaderMap(bounceAuditSheet);
  const auditRows = bounceAuditSheet.getRange(2, 1, bounceAuditSheet.getLastRow() - 1, bounceAuditSheet.getLastColumn()).getValues();
  const applicationJobs = loadBounceTrackingJobs(applicationsSheet, true);
  if (!applicationJobs.length) return 0;

  let reconciled = 0;
  let auditChanged = false;
  auditRows.forEach((auditRow, auditOffset) => {
    const status = String(auditRow[auditHeaderMap['Status']] || '').trim().toUpperCase();
    if (status !== LOG_STATUS_BOUNCE_UNMATCHED) return;

    const classification = buildBounceClassificationFromAuditRow(
      auditRow[auditHeaderMap['Bounce Type']],
      auditRow[auditHeaderMap['Bounce Code']],
      auditRow[auditHeaderMap['Diagnostic']]
    );
    if (!classification) return;

    const targetEmailText = String(auditRow[auditHeaderMap['Target Email']] || '').trim();
    const recipientHints = splitAlignedCsv(targetEmailText).map(sanitizeEmailAddress).filter(Boolean);
    const searchable = `${auditRow[auditHeaderMap['Subject']] || ''}\n${auditRow[auditHeaderMap['Diagnostic']] || ''}\n${targetEmailText}`.toLowerCase();
    const resolvedTargets = resolveBounceTargets(applicationJobs, searchable, recipientHints, true);
    if (!resolvedTargets.length) return;

    const suppressRecipient = shouldSuppressBounceRecipient(classification);
    const detectedAt = normalizeSheetTimestamp(auditRow[auditHeaderMap['Detected At']]) || getCurrentTimestampString();
    const messageId = String(auditRow[auditHeaderMap['Gmail Message ID']] || '').trim();
    const matchedLabels = [];

    resolvedTargets.forEach(target => {
      const job = target.job;
      const emailIndex = target.emailIndex;
      const email = job.emails[emailIndex];
      if (!email) return;

      const existingStatus = String(job.statuses[emailIndex] || '').toUpperCase();
      const existingSuppressed = String(job.bounceSuppressed[emailIndex] || '').toUpperCase();
      const existingBounceMessageId = String(job.bounceMessageIds[emailIndex] || '').trim();
      const shouldApplyToRecipient = existingStatus !== 'BOUNCED' ||
        !existingBounceMessageId ||
        (existingSuppressed !== 'YES' && suppressRecipient);

      // Do not replace already-durable permanent bounce evidence with an older
      // audit event. A replay may still reconcile the audit row to that
      // application without mutating the recipient slot.
      if (shouldApplyToRecipient) {
        persistMatchedBounceToApplication(applicationsSheet, job, emailIndex, classification, suppressRecipient, messageId, detectedAt);
      }
      if (suppressRecipient) persistBouncedAddress(email);
      matchedLabels.push(`${job.jobId || `row:${job.rowIndex}`} -> ${email}${shouldApplyToRecipient ? '' : ' (already terminal)'}`);
    });

    if (!matchedLabels.length) return;
    auditRow[auditHeaderMap['Status']] = LOG_STATUS_BOUNCE_RECONCILED;
    auditRow[auditHeaderMap['Bounce Suppressed']] = suppressRecipient ? 'YES' : 'NO';
    if (typeof auditHeaderMap['Run ID'] === 'number') auditRow[auditHeaderMap['Run ID']] = RUN_METRICS.runId;
    if (typeof auditHeaderMap['Notes'] === 'number') {
      const note = `Reconciled to Applications: ${matchedLabels.join('; ')}.`;
      const existing = String(auditRow[auditHeaderMap['Notes']] || '').trim();
      auditRow[auditHeaderMap['Notes']] = existing && !existing.includes(note) ? `${existing} | ${note}` : (existing || note);
    }
    auditChanged = true;
    reconciled++;
  });

  if (auditChanged) {
    bounceAuditSheet.getRange(2, 1, auditRows.length, auditRows[0].length).setValues(auditRows);
    vLog(`[BOUNCE TRACKER] Reconciled ${reconciled} previously unmatched Bounce Audit event(s) against Applications.`);
  }
  return reconciled;
}

function getLoggedBounceMessageIds(applicationsSheet, bounceAuditSheet) {
  const ids = new Set();
  const headerMap = getSheetHeaderMap(applicationsSheet);
  if (applicationsSheet.getLastRow() > 1) {
    const rows = applicationsSheet.getRange(2, 1, applicationsSheet.getLastRow() - 1, applicationsSheet.getLastColumn()).getValues();
    rows.forEach(row => {
      for (let slot = 1; slot <= MAX_APPLICATION_RECIPIENT_SLOTS; slot++) {
        const id = String(getApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Message ID`) || '').trim();
        if (id) ids.add(id);
      }
    });
  }
  if (bounceAuditSheet && bounceAuditSheet.getLastRow() > 1) {
    const auditHeaderMap = getSheetHeaderMap(bounceAuditSheet);
    const col = auditHeaderMap['Gmail Message ID'];
    if (typeof col === 'number') {
      bounceAuditSheet.getRange(2, col + 1, bounceAuditSheet.getLastRow() - 1, 1).getValues().forEach(row => {
        const id = String(row[0] || '').trim();
        if (id) ids.add(id);
      });
    }
  }
  return ids;
}

function persistMatchedBounceToApplication(sheet, job, emailIndex, classification, suppressRecipient, messageId, detectedAt) {
  const row = job.rowValues;
  const headerMap = job.headerMap;
  const slot = emailIndex + 1;
  setApplicationRowValue(row, headerMap, `Recipient ${slot} Delivery Status`, 'BOUNCED');
  setApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Type`, classification.type);
  setApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Code`, classification.statusCode || '');
  setApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Suppressed`, suppressRecipient ? 'YES' : 'NO');
  setApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Message ID`, messageId || '');
  setApplicationRowValue(row, headerMap, `Recipient ${slot} Bounce Detected At`, detectedAt || getCurrentTimestampString());
  setApplicationRowValue(row, headerMap, 'Dispatch Status', deriveDispatchStatusFromApplicationRow(row, headerMap) || 'BOUNCED');
  setApplicationRowValue(row, headerMap, 'Updated At', detectedAt || getCurrentTimestampString());
  setApplicationRowValue(row, headerMap, 'Last Run ID', RUN_METRICS.runId);
  sheet.getRange(job.rowIndex, 1, 1, row.length).setValues([row]);

  job.statuses[emailIndex] = 'BOUNCED';
  job.bounceTypes[emailIndex] = classification.type;
  job.bounceCodes[emailIndex] = classification.statusCode || '';
  job.bounceSuppressed[emailIndex] = suppressRecipient ? 'YES' : 'NO';
  job.bounceMessageIds[emailIndex] = messageId || '';
  job.bounceDetectedAt[emailIndex] = detectedAt || '';
}

function appendBounceAuditRecord(params, sheet) {
  ensureBounceAuditSheetSchema(sheet);
  const messageId = String(params.gmailMessageId || '').trim();
  if (messageId && sheet.getLastRow() > 1) {
    const headerMap = getSheetHeaderMap(sheet);
    const col = headerMap['Gmail Message ID'];
    if (typeof col === 'number') {
      const existing = sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues();
      if (existing.some(row => String(row[0] || '').trim() === messageId)) return true;
    }
  }
  const row = [
    params.detectedAt || getCurrentTimestampString(),
    messageId,
    params.gmailThreadId || '',
    params.status || LOG_STATUS_BOUNCE_UNMATCHED,
    params.bounceType || '',
    params.bounceCode || '',
    params.bounceSuppressed || 'NO',
    params.targetEmail || '',
    params.subject || '',
    params.diagnostic || '',
    params.archivedAt || '',
    RUN_METRICS.runId,
    params.notes || ''
  ];
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return true;
}

function markBounceAuditMessagesArchived(sheet, messageIds, archivedAt) {
  const ids = new Set((messageIds || []).map(v => String(v || '').trim()).filter(Boolean));
  if (!ids.size || !sheet || sheet.getLastRow() <= 1) return;
  const headerMap = getSheetHeaderMap(sheet);
  const messageCol = headerMap['Gmail Message ID'];
  const archivedCol = headerMap['Archived At'];
  if (typeof messageCol !== 'number' || typeof archivedCol !== 'number') return;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  let changed = false;
  values.forEach(row => {
    const id = String(row[messageCol] || '').trim();
    if (ids.has(id) && !row[archivedCol]) {
      row[archivedCol] = archivedAt;
      changed = true;
    }
  });
  if (changed) sheet.getRange(2, 1, values.length, values[0].length).setValues(values);
}

function getProcessedJobIds(config) {
  vLog('[PRE-FILTER] Compiling list of previously processed Job IDs from Applications...');
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) return new Set();
  try {
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetLogId);
    const sheet = getOrCreateApplicationsSheet(spreadsheet);
    const headerMap = getSheetHeaderMap(sheet);
    const processed = new Set();
    if (sheet.getLastRow() > 1) {
      const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
      rows.forEach(row => {
        const jobId = String(getApplicationRowValue(row, headerMap, 'Job ID') || '').trim();
        const coreStatus = String(getApplicationRowValue(row, headerMap, 'Core Status') || '').trim().toUpperCase();
        if (jobId && coreStatus === LOG_STATUS_CORE_PROCESSED) processed.add(jobId);
      });
    }
    vLog(`  - [PRE-FILTER] Detected ${processed.size} historically processed Job IDs.`);
    return processed;
  } catch (e) {
    vLog(`  - [PRE-FILTER] Warning: Failed to populate processed cache: ${e.message}`);
    return new Set();
  }
}

function appendToSpreadsheetLog(params, config) {
  vLog(`[SHEET LOG] Building one-row application update for Job ID: ${params.jobId || ''}...`);
  if (!ENABLE_SPREADSHEET_LOGGING || !config.spreadsheetLogId) {
    vLog('[SHEET LOG] Sheet logging bypassed.');
    return false;
  }
  try {
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetLogId);
    if (String(params.status || '').toUpperCase() === LOG_STATUS_BOUNCE_UNMATCHED) {
      const auditSheet = getOrCreateBounceAuditSheet(spreadsheet);
      return appendBounceAuditRecord({
        detectedAt: params.bounceDetectedAt || getCurrentTimestampString(),
        gmailMessageId: params.bounceMessageId || '',
        gmailThreadId: '',
        status: LOG_STATUS_BOUNCE_UNMATCHED,
        bounceType: params.bounceType || '',
        bounceCode: params.bounceCode || '',
        bounceSuppressed: params.bounceSuppressed || 'NO',
        targetEmail: params.targetEmail || '',
        subject: params.jobTitle || '',
        diagnostic: params.messageId || '',
        notes: 'Compatibility path from appendToSpreadsheetLog.'
      }, auditSheet);
    }
    const sheet = getOrCreateApplicationsSheet(spreadsheet);
    return upsertApplicationRecordOnSheet(sheet, params);
  } catch (e) {
    vLog(`  - [SHEET LOG] Warning: Applications upsert failed: ${e.message}`);
    return false;
  }
}
function persistBouncedAddress(email) {
  if (!email) return;
  persistBouncedAddresses([email]);
}

/**
 * Batches persistence of bounced addresses to avoid redundant PropertiesService I/O
 * and enforces safe storage caps to protect against the 9 KB property size limit.
 */
function persistBouncedAddresses(emails) {
  if (!emails || !emails.length) return;
  const normalizedList = (Array.isArray(emails) ? emails : Array.from(emails))
    .map(e => String(e || '').trim().toLowerCase())
    .filter(Boolean);
  if (!normalizedList.length) return;

  if (CACHED_BOUNCED_ADDRESS_SET === null) {
    getBouncedAddressSet();
  }
  normalizedList.forEach(e => CACHED_BOUNCED_ADDRESS_SET.add(e));

  try {
    const props = PropertiesService.getScriptProperties();
    const existing = props.getProperty('BOUNCED_ADDRESSES') || '';
    const existingSet = new Set(existing.split('\n').map(e => e.trim()).filter(Boolean));
    let hasNew = false;

    normalizedList.forEach(e => {
      if (!existingSet.has(e)) {
        existingSet.add(e);
        hasNew = true;
      }
    });

    if (hasNew) {
      let arrayToStore = Array.from(existingSet);
      // Guard against Google Apps Script 9,216-byte property limit (target safe cap: 8,000 bytes)
      let serialized = arrayToStore.join('\n');
      if (serialized.length > 8000) {
        AppLogger.warn('BOUNCES', `Bounce suppression store nearing 9 KB quota (${serialized.length} bytes). Pruning oldest entries.`);
        while (arrayToStore.length > 100 && arrayToStore.join('\n').length > 8000) {
          arrayToStore.shift(); // Evict oldest recorded address
        }
        serialized = arrayToStore.join('\n');
      }
      props.setProperty('BOUNCED_ADDRESSES', serialized);
      vLog(`  - [BOUNCE SUPPRESSION] Updated suppression store (total stored: ${arrayToStore.length} addresses).`);
    }
  } catch (e) {
    vLog(`  - [BOUNCE SUPPRESSION] Warning: Could not persist bounced address(es): ${e.message}`);
  }
}

/**
 * Layer 1 (Bounce Suppression) — Returns a Set of all previously-confirmed-bounced
 * email addresses loaded from the Script Properties suppression store.
 */
function getBouncedAddressSet() {
  if (CACHED_BOUNCED_ADDRESS_SET !== null) return CACHED_BOUNCED_ADDRESS_SET;
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty('BOUNCED_ADDRESSES') || '';
    const addresses = raw.split('\n').map(e => e.trim()).filter(Boolean);
    vLog(`  - [BOUNCE SUPPRESSION] Loaded ${addresses.length} suppressed address(es) from store.`);
    CACHED_BOUNCED_ADDRESS_SET = new Set(addresses);
    return CACHED_BOUNCED_ADDRESS_SET;
  } catch (e) {
    vLog(`  - [BOUNCE SUPPRESSION] Warning: Could not read bounce suppression store: ${e.message}`);
    CACHED_BOUNCED_ADDRESS_SET = new Set();
    return CACHED_BOUNCED_ADDRESS_SET;
  }
}

/**
 * Retrieves Job IDs whose core material generation already completed. Dispatch
 * and render outcomes are deliberately treated independently from DOCGEN success.
 */
function parseMarkdown(fileContent) {
  vLog('[PARSER] Initiating markdown syntactic decomposition...');
  if (typeof fileContent !== 'string') {
    throw new Error('Cannot parse file content because it is not a string. File may be empty or corrupted.');
  }

  const metadata = {};
  let content = '';

  let metadataBlock = '';
  let contentBlock = '';

  const frontmatterMatch = fileContent.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n\s*---\s*\r?\n([\s\S]*)$/);
  if (frontmatterMatch) {
    metadataBlock = frontmatterMatch[1];
    contentBlock = frontmatterMatch[2];
    vLog('[PARSER] Detected YAML/frontmatter-style metadata header enclosed by "---".');
  } else {
    const separatorRegex = /\r?\n\s*---\s*\r?\n/;
    const match = fileContent.match(separatorRegex);
    
    if (!match) {
      vLog('[PARSER] [FATAL] Target document layout invalid. Missing metadata block divider (---).');
      throw new Error(`Invalid file format. Could not find the "---" separator.`);
    }

    const splitIndex = match.index;
    metadataBlock = fileContent.substring(0, splitIndex);
    contentBlock = fileContent.substring(splitIndex + match[0].length);
  }
  
  vLog('[PARSER] Successfully divided file segments into Metadata and Content zones.');
  ['Company', 'Job ID'].forEach(fieldName => {
    const value = extractBoldMetadataField(metadataBlock, fieldName);
    if (!value) throw new Error(`Could not find "${fieldName}" in the Job Metadata section.`);
    metadata[fieldName] = value;
  });
  [
    'Job Title', 'Job URL', 'Application Email', 'Company Address', 'Canonical Company', 
    'Canonical Domain', 'ATS Platform', 'Primary Application URL', 'Recruiter Name', 
    'Recruiter Email', 'Hiring Manager Name', 'Hiring Manager Email'
  ].forEach(fieldName => {
    const value = extractBoldMetadataField(metadataBlock, fieldName);
    if (value) {
      metadata[fieldName] = value;
      vLog(`[PARSER] Parsed Field [${fieldName}]: "${value}"`);
    }
  });

  vLog(`[PARSER] Extracted ${Object.keys(metadata).length} raw metadata keys.`);

  // Split by H1 (#) or H2 (##) to properly segment out inputs/appendices
  const sections = contentBlock.split(/(?=^#{1,2}\s+)/m).map(section => section.trim()).filter(Boolean);
  vLog(`[PARSER] Identified ${sections.length} distinct section containers.`);

  sections.forEach((section, idx) => {
    const headerMatch = section.match(/^#{1,2}\s+(.*)/);
    if (!headerMatch) return;
    
    const title = headerMatch[1].trim();
    const value = section.substring(headerMatch[0].length).trim();
    vLog(`  - [PARSER] Evaluating Header #${idx + 1}: Title: "${title}"`);

    let cleanTitle = title.replace(/^(?:Optimized\s*&\s*Tailored|Optimized|Tailored)\s+/i, '').trim();
    if (cleanTitle === 'Materials Filename') {
      cleanTitle = 'Resume Filename';
      vLog(`  - [PARSER] Normalizing 'Materials Filename' -> 'Resume Filename'`);
    }

    if (cleanTitle === 'Cover Letter') {
      // Bulletproof slice: If the generator forgot a newline and jammed ## INPUTS 
      // against the last sentence, this cleanly amputates it.
      content = value.split(/#{1,3}\s*INPUTS/i)[0].trim();
      vLog('  - [PARSER] Segmented and extracted Cover Letter block.');
    } else if (cleanTitle && !/INPUTS/i.test(cleanTitle)) {
      metadata[cleanTitle] = value;
      vLog(`  - [PARSER] Metadata Section Field [${cleanTitle}] mapped => value length: ${value.length} chars.`);
    }
  });

  if (!content) {
    vLog('[PARSER] [FATAL] Critical structural error: Cover Letter text block was not resolved.');
    throw new Error('Could not find a non-empty "# Cover Letter" section in the source material file.');
  }

  return { metadata, content };
}

/**
 * Extracts a markdown bold metadata field flexibly matching variations like **Field:** or **Field**:
 * and handles bullet list variations like - **Field:** or * **Field:**
 */
function extractBoldMetadataField(metadataBlock, fieldName) {
  const escapedFieldName = escapeRegex(fieldName);
  const pattern = new RegExp(`^[\\s\\*\\-]*\\*\\*${escapedFieldName}[\\*:\\s]*(.+?)\\s*$`, 'im');
  const match = String(metadataBlock || '').match(pattern);
  return match && match[1] ? match[1].trim() : '';
}

/**
 * Formats a corporate mailing address as a conservative USPS-style single line:
 *   123 MAIN ST APT 4B, NEW YORK NY 10001
 * Company/contact labels are intentionally excluded because the cover-letter template
 * already has a dedicated company placeholder.
 */
function formatCorporateHQAddressBlock(metadata, rawAddress, companyName) {
  return formatUspsSingleLineAddress(rawAddress, companyName, metadata);
}

function formatUspsSingleLineAddress(rawAddress, companyName, metadata) {
  vLog('[ADDRESS FORMATTING] Starting USPS single-line address normalization...');
  vLog(`[ADDRESS FORMATTING] Input rawAddress: "${rawAddress || ''}"`);

  let raw = decodeCommonHtmlEntities(String(rawAddress || ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\t\u00A0]+/g, ' ')
    .trim();
  if (!raw) return '';

  const removableLabels = [
    companyName,
    getMetadataValue(metadata, 'Canonical Company'),
    getMetadataValue(metadata, 'Hiring Manager Name'),
    getMetadataValue(metadata, 'Recruiter Name')
  ].map(v => oneLinePlainText(v).toUpperCase()).filter(Boolean);

  let parts = raw
    .split(/\n+|\s*;\s*/)
    .map(p => p.trim())
    .filter(Boolean);

  // Preserve comma structure from one-line addresses while removing company/contact-only lines.
  parts = parts.filter(part => {
    const normalized = oneLinePlainText(part).replace(/,+$/, '').trim().toUpperCase();
    return !removableLabels.includes(normalized);
  });

  let joined = parts.join(', ');
  removableLabels.forEach(label => {
    const re = new RegExp(`^${escapeRegex(label)}\\s*[,\\-:]\\s*`, 'i');
    joined = joined.replace(re, '');
  });

  let segments = joined.split(/\s*,\s*/).map(v => v.trim()).filter(Boolean);
  if (segments.length === 0) return '';

  let streetSegments = [];
  let cityStateZip = '';

  if (segments.length >= 2 && looksLikeCityStateZipSegment(segments[segments.length - 1])) {
    cityStateZip = segments.pop();
    streetSegments = segments;
  } else if (segments.length >= 2 && looksLikeStateZipSegment(segments[segments.length - 1])) {
    const stateZip = segments.pop();
    const city = segments.pop() || '';
    cityStateZip = `${city} ${stateZip}`.trim();
    streetSegments = segments;
  } else if (parts.length >= 2) {
    cityStateZip = parts[parts.length - 1];
    streetSegments = parts.slice(0, -1);
  } else {
    // Comma-free one-line fallback: split conservatively using ZIP/state tokens and
    // a recognized street suffix before normalizing street/locality separately.
    const single = oneLinePlainText(segments[0]).toUpperCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
    const split = splitStreetFromCityStateZip(single);
    if (split) {
      streetSegments = [split.street];
      cityStateZip = split.cityStateZip;
    } else {
      vLog(`[ADDRESS FORMATTING] [WARNING] Could not confidently separate street from city/state/ZIP; returning normalized one-line value.`);
      return normalizeUspsAddressText(single, false);
    }
  }

  const street = normalizeUspsAddressText(streetSegments.join(' '), true);
  const locality = normalizeUspsCityStateZip(cityStateZip);
  const finalized = [street, locality].filter(Boolean).join(', ');
  vLog(`[ADDRESS FORMATTING] USPS single-line address: "${finalized}"`);
  return finalized;
}

function getUspsStateMap() {
  return {
    'ALABAMA':'AL','ALASKA':'AK','ARIZONA':'AZ','ARKANSAS':'AR','CALIFORNIA':'CA','COLORADO':'CO','CONNECTICUT':'CT','DELAWARE':'DE',
    'DISTRICT OF COLUMBIA':'DC','FLORIDA':'FL','GEORGIA':'GA','HAWAII':'HI','IDAHO':'ID','ILLINOIS':'IL','INDIANA':'IN','IOWA':'IA',
    'KANSAS':'KS','KENTUCKY':'KY','LOUISIANA':'LA','MAINE':'ME','MARYLAND':'MD','MASSACHUSETTS':'MA','MICHIGAN':'MI','MINNESOTA':'MN',
    'MISSISSIPPI':'MS','MISSOURI':'MO','MONTANA':'MT','NEBRASKA':'NE','NEVADA':'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ','NEW MEXICO':'NM',
    'NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND','OHIO':'OH','OKLAHOMA':'OK','OREGON':'OR','PENNSYLVANIA':'PA',
    'RHODE ISLAND':'RI','SOUTH CAROLINA':'SC','SOUTH DAKOTA':'SD','TENNESSEE':'TN','TEXAS':'TX','UTAH':'UT','VERMONT':'VT','VIRGINIA':'VA',
    'WASHINGTON':'WA','WEST VIRGINIA':'WV','WISCONSIN':'WI','WYOMING':'WY','PUERTO RICO':'PR'
  };
}

function getUspsStateTokens() {
  const stateMap = getUspsStateMap();
  return [...Object.keys(stateMap), ...Object.values(stateMap)]
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .sort((a, b) => b.length - a.length);
}

function looksLikeStateZipSegment(value) {
  const text = String(value || '').trim().toUpperCase().replace(/\./g, '');
  const match = text.match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) return false;
  const stateToken = match[1].trim();
  return getUspsStateTokens().includes(stateToken);
}

function looksLikeCityStateZipSegment(value) {
  const text = String(value || '').trim().toUpperCase().replace(/\./g, '');
  const match = text.match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) return false;
  const preZip = match[1].trim();
  return getUspsStateTokens().some(stateToken => {
    const suffix = ` ${stateToken}`;
    return preZip.endsWith(suffix) && preZip.slice(0, -suffix.length).trim().length > 0;
  });
}

function splitStreetFromCityStateZip(value) {
  const text = String(value || '').trim().toUpperCase().replace(/[.]/g, '').replace(/\s+/g, ' ');
  const zipMatch = text.match(/^(.*?)\s+(\d{5}(?:-\d{4})?)$/);
  if (!zipMatch) return null;

  const beforeZip = zipMatch[1].trim();
  const zip = zipMatch[2];
  const stateToken = getUspsStateTokens().find(token => beforeZip === token || beforeZip.endsWith(` ${token}`));
  if (!stateToken) return null;

  const beforeState = beforeZip.slice(0, beforeZip.length - stateToken.length).trim();
  if (!beforeState) return null;
  const streetSuffix = '(?:STREET|ST|AVENUE|AVE|BOULEVARD|BLVD|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|CIRCLE|CIR|PARKWAY|PKWY|HIGHWAY|HWY|WAY|PLACE|PL|TERRACE|TER)';
  const directional = '(?:N|S|E|W|NE|NW|SE|SW)';
  const unit = '(?:APARTMENT|APT|SUITE|STE|UNIT|FLOOR|FL|BUILDING|BLDG|ROOM|RM|DEPARTMENT|DEPT|#)';
  const streetCity = beforeState.match(new RegExp(`^(.+?\\b${streetSuffix}(?:\\s+${directional})?(?:\\s+${unit}\\s*[A-Z0-9-]+)?)\\s+(.+)$`, 'i'));
  if (!streetCity) return null;

  return {
    street: streetCity[1].trim(),
    cityStateZip: `${streetCity[2].trim()} ${stateToken} ${zip}`
  };
}

function normalizeUspsAddressText(value, isStreet) {
  let text = oneLinePlainText(value)
    .toUpperCase()
    .replace(/[.]/g, '')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (isStreet) {
    const replacements = [
      [/\bSTREET\b/g, 'ST'], [/\bAVENUE\b/g, 'AVE'], [/\bBOULEVARD\b/g, 'BLVD'],
      [/\bROAD\b/g, 'RD'], [/\bDRIVE\b/g, 'DR'], [/\bLANE\b/g, 'LN'], [/\bCOURT\b/g, 'CT'],
      [/\bCIRCLE\b/g, 'CIR'], [/\bPARKWAY\b/g, 'PKWY'], [/\bHIGHWAY\b/g, 'HWY'],
      [/\bPLACE\b/g, 'PL'], [/\bTERRACE\b/g, 'TER'], [/\bAPARTMENT\b/g, 'APT'],
      [/\bSUITE\b/g, 'STE'], [/\bBUILDING\b/g, 'BLDG'], [/\bFLOOR\b/g, 'FL'],
      [/\bROOM\b/g, 'RM'], [/\bDEPARTMENT\b/g, 'DEPT']
    ];
    replacements.forEach(([pattern, replacement]) => { text = text.replace(pattern, replacement); });
  }
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeUspsCityStateZip(value) {
  let text = normalizeUspsAddressText(value, false).replace(/\s*,\s*/g, ' ');
  const stateMap = getUspsStateMap();
  Object.keys(stateMap).sort((a,b) => b.length-a.length).some(stateName => {
    const re = new RegExp(`\\b${escapeRegex(stateName)}\\b(?=\\s+\\d{5}(?:-\\d{4})?$)`);
    if (re.test(text)) {
      text = text.replace(re, stateMap[stateName]);
      return true;
    }
    return false;
  });
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Fallback to fetch only the corporate HQ address if LLM discovery was skipped (manual email used).
 */
function fetchCompanyAddress(companyName, metadata, config) {
  vLog(`[ADDRESS SCRAPER] Accessing corporate mailing records for: ${companyName}...`);
  const jobUrl = getMetadataValue(metadata, 'Job URL');
  const canonicalDomain = getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(jobUrl);

  const prompt = `
Return the best current corporate mailing address for the company below.

Company: ${companyName || 'UNKNOWN'}
Canonical domain, if known: ${canonicalDomain || 'UNKNOWN'}
Job URL, if known: ${jobUrl || 'UNKNOWN'}

Rules:
- Prefer the company entity connected to the provided job URL/domain.
- Avoid similarly named but unrelated companies.
- Return only the postal mailing address; do not include company name or contact name.
- Prefer USPS single-line format in ALL CAPS: 123 MAIN ST APT 4B, NEW YORK NY 10001.
- Include street number, city, two-letter state abbreviation, and ZIP/ZIP+4 when known.
- Return only the address. No commentary.
`.trim();

  vLog(`[ADDRESS SCRAPER] Prompt payload built. length: ${prompt.length} characters.`);
  try {
    const fullResponse = askOpenRouter(prompt, config, { temperature: 0.15, top_p: 0.8, maxTokens: OPENROUTER_ADDRESS_MAX_TOKENS });
    const cleaned = cleanOpenRouterPlainTextResponse(fullResponse);
    vLog(`[ADDRESS SCRAPER] Resolved Mailing Address response:\n${cleaned}`);
    return cleaned;
  } catch (e) {
    vLog(`[ADDRESS SCRAPER] [WARNING] Corporate address lookup failed: ${e.message}`);
    return getMetadataValue(metadata, 'Company Address') || '';
  }
}

/**
 * Cleans common non-answer artifacts and reasoning tags from OpenRouter plaintext responses.
 */
function cleanOpenRouterPlainTextResponse(fullResponse) {
  let cleaned = String(fullResponse || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '');
  const lines = cleaned.split('\n');
  const filteredLines =[];

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    if (trimmedLine === '---') break;
    if (trimmedLine.startsWith('>') || trimmedLine.startsWith('[')) continue;
    if (trimmedLine.includes('*Thinking...*')) continue; 
    filteredLines.push(lines[i]);
  }

  return filteredLines.join('\n').trim();
}

/**
 * Calls OpenRouter and returns choices[0].message.content with bounded retry/backoff.
 *
 * Defaults intentionally cap a single logical LLM operation at two 30-second attempts.
 * Retries are limited to transport failures and transient HTTP statuses.
 */
function askOpenRouter(prompt, config, overrides) {
  overrides = overrides || {};
  const maxAttempts = typeof overrides.maxAttempts === 'number'
    ? Math.max(1, Math.floor(overrides.maxAttempts))
    : OPENROUTER_MAX_ATTEMPTS;
  const retryBaseMs = typeof overrides.retryBaseMs === 'number'
    ? Math.max(0, Math.floor(overrides.retryBaseMs))
    : OPENROUTER_RETRY_BASE_DELAY_MS;
  const timeoutSeconds = typeof overrides.timeoutSeconds === 'number'
    ? Math.max(1, Math.floor(overrides.timeoutSeconds))
    : OPENROUTER_REQUEST_TIMEOUT_SECONDS;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!hasOpenRouterExecutionBudget(timeoutSeconds)) {
      const remainingMs = Math.max(0, SAFE_EXECUTION_LIMIT_MS - (Date.now() - RUN_METRICS.startTime));
      const budgetError = new Error(
        `OpenRouter request skipped because only ${Math.floor(remainingMs / 1000)}s remain in the safe execution window.`
      );
      budgetError.retryable = false;
      throw budgetError;
    }

    try {
      vLog(
        `[LLM GATEWAY] Invoking OpenRouter transaction [Attempt ${attempt}/${maxAttempts}] ` +
        `(timeout=${timeoutSeconds}s)...`
      );
      return askOpenRouterOnce(prompt, config, Object.assign({}, overrides, { timeoutSeconds }));
    } catch (e) {
      lastError = e;
      const shouldRetry = isRetryableOpenRouterError(e) && attempt < maxAttempts;
      if (!shouldRetry) {
        vLog(`[LLM GATEWAY] [FATAL] Transaction failed without further retry: ${e.message}`);
        throw e;
      }

      const sleepMs = retryBaseMs * Math.pow(2, attempt - 1);
      if (!hasOpenRouterExecutionBudget(timeoutSeconds, sleepMs)) {
        vLog('[LLM GATEWAY] Retry suppressed because the remaining safe execution budget is insufficient.');
        throw e;
      }

      vLog(
        `[LLM GATEWAY] Attempt ${attempt}/${maxAttempts} failed with a retryable error: ${e.message}. ` +
        `Retrying in ${sleepMs} ms.`
      );
      Utilities.sleep(sleepMs);
    }
  }

  throw lastError || new Error('OpenRouter API request failed for an unknown reason.');
}

/**
 * Returns whether there is enough room in the script's safe execution window to
 * start another bounded OpenRouter attempt.
 */
function hasOpenRouterExecutionBudget(timeoutSeconds, additionalDelayMs) {
  const elapsedMs = Date.now() - RUN_METRICS.startTime;
  const requestBudgetMs = Math.max(1, Number(timeoutSeconds) || OPENROUTER_REQUEST_TIMEOUT_SECONDS) * 1000;
  const delayMs = Math.max(0, Number(additionalDelayMs) || 0);
  return elapsedMs + delayMs + requestBudgetMs + OPENROUTER_EXECUTION_CUSHION_MS < SAFE_EXECUTION_LIMIT_MS;
}

/**
 * Calls OpenRouter once.
 */
function askOpenRouterOnce(prompt, config, overrides) {
  overrides = overrides || {};
  const timeoutSeconds = typeof overrides.timeoutSeconds === 'number'
    ? Math.max(1, Math.floor(overrides.timeoutSeconds))
    : OPENROUTER_REQUEST_TIMEOUT_SECONDS;
  const maxTokens = typeof overrides.maxTokens === 'number'
    ? Math.max(1, Math.floor(overrides.maxTokens))
    : OPENROUTER_DEFAULT_MAX_TOKENS;
  const maxResponseChars = typeof overrides.maxResponseChars === 'number'
    ? Math.max(1000, Math.floor(overrides.maxResponseChars))
    : OPENROUTER_MAX_RESPONSE_CHARS;

  const payload = {
    model: OPENROUTER_MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    temperature: typeof overrides.temperature === 'number' ? overrides.temperature : 0.25,
    top_p: typeof overrides.top_p === 'number' ? overrides.top_p : 0.9,
    max_tokens: maxTokens
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `Bearer ${config.orApiKey}`,
      'HTTP-Referer': 'https://google.com',
      'X-Title': 'Apps Script Job Material Pipeline'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    timeoutSeconds: timeoutSeconds
  };

  vLog(`[API EXECUTION] Target endpoint: ${OPENROUTER_API_URL}`);
  vLog(`[API EXECUTION] Active model mapping: ${OPENROUTER_MODEL}`);
  vLog(`[API EXECUTION] Request timeout: ${timeoutSeconds}s | max_tokens: ${maxTokens}`);
  vLog(`[API EXECUTION] Payload parameters size: ${JSON.stringify(payload).length} chars.`);

  let response;
  try {
    response = UrlFetchApp.fetch(OPENROUTER_API_URL, options);
  } catch (fetchError) {
    const error = new Error(`OpenRouter transport/timeout failure: ${fetchError.message || fetchError}`);
    error.retryable = true;
    error.transportError = true;
    throw error;
  }

  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  vLog(`[API EXECUTION] Returned raw response Code: ${responseCode}`);
  vLog(`[API EXECUTION] Raw response payload length: ${responseBody.length} characters.`);

  if (responseCode !== 200) {
    vLog(`[API ERROR] Non-200 Status (${responseCode}): ${truncateText(responseBody, 300)}`);
    const error = new Error(
      `OpenRouter API request failed with status code ${responseCode}. Response: ${truncateText(responseBody, 500)}`
    );
    error.responseCode = responseCode;
    throw error;
  }

  let jsonResponse;
  try {
    jsonResponse = JSON.parse(responseBody);
  } catch (parseError) {
    vLog('[API ERROR] Execution returned malformed JSON payload.');
    const error = new Error('OpenRouter API returned non-JSON response.');
    error.retryable = false;
    throw error;
  }

  const content = jsonResponse?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    if (jsonResponse?.error?.message) {
      vLog(`[API ERROR] OpenRouter returned API error: ${jsonResponse.error.message}`);
      const error = new Error(`OpenRouter API returned error: ${jsonResponse.error.message}`);
      error.retryable = false;
      throw error;
    }
    vLog('[API ERROR] Complied structure is missing text targets choices[0].message.content.');
    const error = new Error('OpenRouter API response did not contain message content.');
    error.retryable = false;
    throw error;
  }

  if (content.length > maxResponseChars) {
    const error = new Error(
      `OpenRouter content exceeded safety limit (${content.length} > ${maxResponseChars} characters).`
    );
    error.retryable = false;
    throw error;
  }

  vLog(`[API SUCCESS] Extracted choice content (${content.length} characters). Preview:\n${content.substring(0, 300)}...`);
  return content.trim();
}

/**
 * Returns true only for transient OpenRouter/API failures worth retrying.
 */
function isRetryableOpenRouterError(error) {
  if (!error) return false;
  if (typeof error.retryable === 'boolean') return error.retryable;

  if (error.responseCode) {
    const code = Number(error.responseCode);
    return code === 408 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
  }

  return false;
}

/**
 * Discovers ranked application and hail-mary email routes, AND extracts company address.
 */
function discoverApplicationEmailRoutes(metadata, config) {
  vLog('[DISCOVERY] Initiating strategic intake and contact routing heuristics...');
  const manualCandidate = getManualEmailCandidate(metadata);

  if (manualCandidate && manualCandidate.recommendedAction !== DISCOVERY_ACTIONS.SUPPRESS) {
    vLog(`[DISCOVERY] Manually declared routing override resolved: "${manualCandidate.email}". Skipping API intelligence lookup.`);
    return normalizeApplicationEmailDiscoveryResult({
      canonical_company: getMetadataValue(metadata, 'Canonical Company') || getMetadataValue(metadata, 'Company'),
      canonical_domain: getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(getMetadataValue(metadata, 'Job URL')),
      entity_confidence: 1,
      primary_application_url: getMetadataValue(metadata, 'Primary Application URL') || getMetadataValue(metadata, 'Job URL'),
      ats_platform: getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(getMetadataValue(metadata, 'Job URL')),
      all_candidates: [manualCandidate],
      suppressed_candidates:[],
      notes: 'Manual source-file email detected. AI Discovery skipped.'
    }, metadata, 'manual');
  }

  vLog('[DISCOVERY] No valid manual email detected. Querying LLM matrix mapping via OpenRouter...');
  let parsed = null;
  let fullResponse = '';

  try {
    const prompt = buildApplicationEmailDiscoveryPrompt(metadata, config);
    fullResponse = askOpenRouter(prompt, config, { temperature: 0.12, top_p: 0.75, maxTokens: OPENROUTER_DISCOVERY_MAX_TOKENS });
    vLog('[DISCOVERY] Extracting JSON structure from raw text response...');
    parsed = parseJsonObjectFromText(fullResponse);
  } catch (e) {
    vLog(`[DISCOVERY] [WARNING] Email discovery API call or parsing failed: ${e.message}`);
    if (manualCandidate) {
      vLog(`[DISCOVERY] Falling back to manual email candidate: "${manualCandidate.email}"`);
      return normalizeApplicationEmailDiscoveryResult({
        canonical_company: getMetadataValue(metadata, 'Canonical Company') || getMetadataValue(metadata, 'Company'),
        canonical_domain: getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(getMetadataValue(metadata, 'Job URL')),
        entity_confidence: 1,
        primary_application_url: getMetadataValue(metadata, 'Primary Application URL') || getMetadataValue(metadata, 'Job URL'),
        ats_platform: getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(getMetadataValue(metadata, 'Job URL')),
        all_candidates: [manualCandidate],
        suppressed_candidates: [],
        notes: `OpenRouter lookup failed (${e.message}). Used manual candidate fallback.`
      }, metadata, 'manual');
    }

    return normalizeApplicationEmailDiscoveryResult({
      canonical_company: getMetadataValue(metadata, 'Canonical Company') || getMetadataValue(metadata, 'Company'),
      canonical_domain: getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(getMetadataValue(metadata, 'Job URL')),
      entity_confidence: 0,
      primary_application_url: getMetadataValue(metadata, 'Primary Application URL') || getMetadataValue(metadata, 'Job URL'),
      ats_platform: getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(getMetadataValue(metadata, 'Job URL')),
      all_candidates: [],
      suppressed_candidates: [],
      notes: `Email discovery API/parsing failed: ${e.message}`
    }, metadata, 'openrouter');
  }

  vLog('[DISCOVERY] Executing normalization engine...');
  const normalized = normalizeApplicationEmailDiscoveryResult(parsed, metadata, 'openrouter');
  normalized.rawResponse = fullResponse;

  if (manualCandidate) {
    vLog(`[DISCOVERY] Merging suppressed candidate record to suppression list: ${manualCandidate.email}`);
    normalized.suppressedCandidates.push(manualCandidate);
  }

  vLog(`[DISCOVERY] Strategic tracking finished. Best resolved email endpoint: ${normalized.bestEmail || 'NONE'} (Priority Score: ${normalized.score})`);
  return normalized;
}

/**
 * Builds the Strategic Contact Discovery prompt.
 */
function buildApplicationEmailDiscoveryPrompt(metadata, config) {
  const companyName = getMetadataValue(metadata, 'Company');
  const jobId = getMetadataValue(metadata, 'Job ID');
  const jobUrl = getMetadataValue(metadata, 'Job URL');
  const jobTitle = getBestJobTitle(metadata);
  const companyAddress = getMetadataValue(metadata, 'Company Address');
  const canonicalCompany = getMetadataValue(metadata, 'Canonical Company');
  const canonicalDomain = getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(jobUrl);
  const atsPlatform = getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(jobUrl);

  vLog(`[PROMPT BUILDER] Fetching parameters: Company="${companyName}", Title="${jobTitle}", JobID="${jobId}"`);

  return `
You are performing Strategic Contact Discovery for a job application hail-mary workflow.

Goal:
Find the most suitable publicly documented professional email address that could plausibly route a resume and cover letter to recruiting, talent acquisition, HR, the hiring team, or a general company intake.

Inputs:
- Company / organization: ${companyName || 'UNKNOWN'}
- Canonical company, if known: ${canonicalCompany || 'UNKNOWN'}
- Canonical domain, if known: ${canonicalDomain || 'UNKNOWN'}
- Job title: ${jobTitle || 'UNKNOWN'}
- Job ID: ${jobId || 'UNKNOWN'}
- Job URL: ${jobUrl || 'UNKNOWN'}
- Detected ATS platform, if known: ${atsPlatform || 'UNKNOWN'}
- Company address, if known: ${companyAddress || 'UNKNOWN'}
- Applicant name: ${config.applicantName}

Critical entity-resolution rules:
1. Verify the correct company entity and canonical domain before recommending any address.
2. Reject similarly named but unrelated companies.
3. If you detect an ATS platform, return the most direct ATS job/application URL as primary_application_url.
4. Prefer documented email addresses with direct evidence. If no explicit inbox can be verified, include at most one conservative fallback route tied to the canonical domain, clearly caveated with lower confidence.

Evidence requirements:
- Populate evidence_urls with real, verifiable URLs where you actually found the address (e.g. the company's own careers page, an official job posting, a press release). Do not fabricate or guess URLs.
- If you have no documentary evidence for an address, set source_type to "unknown" or "heuristic_pattern", confidence to 0.60 or lower, and include a clear caveat.
- A plausible-looking address with zero evidence is NOT the same as a known address. Mark it backup_only or suppress it — do not set it as best_email.

Email tiering:
A. OFFICIAL_APPLICATION_INTAKE: Explicitly accepts applications/resumes.
B. OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT: Recruiting, careers, talent, candidate help, or TA-adjacent.
C. OFFICIAL_GENERAL_CONTACT: contact@, info@, hello@, or equivalent official company intake.
D. PUBLIC_RECRUITER_OR_HIRING_TEAM: Publicly listed professional email for relevant recruiter.
E. OTHER_PUBLIC_ROUTE: Public but weaker route.
F. SUPPRESSED: Do not use.

Suppression rules:
- Do NOT recommend no-reply, privacy, security, abuse, legal, press, media, investor-relations, postmaster, webmaster, billing, sales, or unrelated departmental inboxes.
- Do NOT recommend disability-accommodation or accessibility-specific inboxes.
- Do NOT return multiple speculative guessed inboxes; keep speculative fallbacks to one maximum and clearly caveated.

Return ONLY valid JSON. No markdown. No commentary outside JSON.

JSON schema:
{
  "company_mailing_address": "string (postal address only, no company/contact name; prefer USPS single-line ALL CAPS format such as 123 MAIN ST APT 4B, NEW YORK NY 10001, or null)",
  "canonical_company": "string",
  "canonical_domain": "string",
  "entity_confidence": 0.0,
  "entity_notes": "brief explanation, especially any collision risk",
  "primary_application_url": "Prefer the direct ATS job/application URL over LinkedIn when discoverable.",
  "ats_platform": "string or null",
  "best_email": {
    "email": "string or null",
    "tier": "OFFICIAL_APPLICATION_INTAKE | OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT | OFFICIAL_GENERAL_CONTACT | PUBLIC_RECRUITER_OR_HIRING_TEAM | OTHER_PUBLIC_ROUTE | SUPPRESSED",
    "confidence": 0.0,
    "score": 0,
    "source_type": "official_company_page | official_careers_page | official_job_posting | ats_page | public_professional_page | third_party | heuristic_pattern | manual | unknown",
    "evidence_urls":["string"],
    "evidence_summary": "brief evidence summary",
    "caveat": "brief caveat",
    "recommended_action": "create_draft | backup_only | suppress"
  },
  "all_candidates":[
    {
      "email": "string",
      "tier": "OFFICIAL_APPLICATION_INTAKE | OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT | OFFICIAL_GENERAL_CONTACT | PUBLIC_RECRUITER_OR_HIRING_TEAM | OTHER_PUBLIC_ROUTE | SUPPRESSED",
      "confidence": 0.0,
      "score": 0,
      "source_type": "official_company_page | official_careers_page | official_job_posting | ats_page | public_professional_page | third_party | heuristic_pattern | manual | unknown",
      "evidence_urls":["string"],
      "evidence_summary": "brief evidence summary",
      "caveat": "brief caveat",
      "recommended_action": "create_draft | backup_only | suppress"
    }
  ],
  "suppressed_candidates":[
    {
      "email": "string",
      "reason": "brief reason"
    }
  ],
  "notes": "brief notes"
}
`.trim();
}

/**
 * Returns a manual metadata email candidate, if supplied.
 */
function getManualEmailCandidate(metadata) {
  const manualSource = getManualEmailSource(metadata);
  const manualEmail = sanitizeEmailAddress(manualSource.email);

  if (!manualEmail) return null;
  vLog(`[DISCOVERY] Manual configuration parsed from source variables: ${manualEmail}`);

  const baseCandidate = {
    email: manualEmail,
    tier: manualSource.tier,
    confidence: manualSource.confidence,
    score: manualSource.score,
    sourceType: 'manual',
    evidenceUrls:[],
    evidenceSummary: manualSource.evidenceSummary,
    caveat: manualSource.caveat,
    recommendedAction: manualSource.recommendedAction
  };

  if (!isValidEmailAddress(manualEmail)) {
    vLog(`[DISCOVERY] [WARNING] Declared manual routing address fails syntax check. Suppressing.`);
    baseCandidate.tier = DISCOVERY_TIERS.SUPPRESSED;
    baseCandidate.recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    return baseCandidate;
  }

  const suppressionReason = getSuppressionReasonForEmail(manualEmail, {
    evidenceSummary: manualSource.evidenceSummary,
    caveat: manualSource.caveat,
    tier: manualSource.tier,
    sourceType: 'manual'
  });

  if (suppressionReason) {
    vLog(`[DISCOVERY] [WARNING] Declared manual routing matches rule suppression criteria: ${suppressionReason}`);
    baseCandidate.tier = DISCOVERY_TIERS.SUPPRESSED;
    baseCandidate.recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    baseCandidate.suppressionReason = suppressionReason;
  }

  return baseCandidate;
}

/**
 * Returns the highest-priority manual email source from metadata.
 */
function getManualEmailSource(metadata) {
  const sources =[
    {
      field: 'Application Email',
      email: getMetadataValue(metadata, 'Application Email'),
      tier: DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE,
      confidence: 1,
      score: 100,
      evidenceSummary: 'Application Email was supplied directly in the material file.',
      caveat: 'Manual source-file value used.',
      recommendedAction: DISCOVERY_ACTIONS.CREATE_DRAFT
    },
    {
      field: 'Recruiter Email',
      email: getMetadataValue(metadata, 'Recruiter Email'),
      tier: DISCOVERY_TIERS.PUBLIC_RECRUITER_OR_HIRING_TEAM,
      confidence: 0.86,
      score: 82,
      evidenceSummary: 'Recruiter Email was supplied directly in the material file.',
      caveat: 'Manual recruiter route.',
      recommendedAction: DISCOVERY_ACTIONS.CREATE_DRAFT
    },
    {
      field: 'Hiring Manager Email',
      email: getMetadataValue(metadata, 'Hiring Manager Email'),
      tier: DISCOVERY_TIERS.PUBLIC_RECRUITER_OR_HIRING_TEAM,
      confidence: 0.90,
      score: 85,
      evidenceSummary: 'Hiring Manager Email was supplied directly in the material file.',
      caveat: 'Manual hiring manager route.',
      recommendedAction: DISCOVERY_ACTIONS.CREATE_DRAFT
    }
  ];

  for (let i = 0; i < sources.length; i++) {
    if (sanitizeEmailAddress(sources[i].email)) return sources[i];
  }

  return { email: '', tier: DISCOVERY_TIERS.SUPPRESSED, recommendedAction: DISCOVERY_ACTIONS.SUPPRESS };
}

/**
 * Parses a JSON object from an LLM response safely, resilient to reasoning tags,
 * markdown code fences, and trailing commas.
 */
function parseJsonObjectFromText(text) {
  let cleaned = String(text || '').trim();
  const cleanTrailingCommas = (str) => String(str || '').replace(/,\s*([}\]])/g, '$1');

  // 1. Strip closed <think>...</think> tags first
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Extract and parse markdown code fences (```json ... ``` or ``` ... ```) if present
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match;
  while ((match = fenceRegex.exec(cleaned)) !== null) {
    const inner = match[1].trim();
    try {
      return JSON.parse(cleanTrailingCommas(inner));
    } catch (e) {
      const fb = inner.indexOf('{');
      const lb = inner.lastIndexOf('}');
      if (fb >= 0 && lb > fb) {
        try {
          return JSON.parse(cleanTrailingCommas(inner.substring(fb, lb + 1)));
        } catch (innerErr) {
          // Continue to next code fence if available
        }
      }
    }
  }

  // 3. Strip leading/trailing code fence markers if unclosed
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 4. Try direct parse
  try {
    return JSON.parse(cleanTrailingCommas(cleaned));
  } catch (directError) {
    AppLogger.debug('LLM', 'Direct JSON parse failed. Extracting matching text block boundaries...');
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const candidate = cleanTrailingCommas(cleaned.substring(firstBrace, lastBrace + 1));
        return JSON.parse(candidate);
      } catch (e) {
        AppLogger.warn('LLM', `Substring block extraction parsed invalid structural JSON: ${e.message}`);
        throw new Error(`Extracted JSON was invalid: ${e.message}`);
      }
    }
    throw new Error(`Could not locate a valid JSON object in OpenRouter response.`);
  }
}

/**
 * Normalizes the ranked discovery result and applies deterministic scoring/suppression.
 */
function normalizeApplicationEmailDiscoveryResult(result, metadata, source) {
  result = result || {};

  const canonicalDomain = normalizeDomain(result.canonical_domain || result.canonicalDomain || getMetadataValue(metadata, 'Canonical Domain'));
  const canonicalCompany = oneLinePlainText(result.canonical_company || result.canonicalCompany || getMetadataValue(metadata, 'Company'));
  const companyMailingAddress = cleanLlmText(result.company_mailing_address || result.companyMailingAddress || '');

  vLog(`[NORMALIZER] Derived Domain: "${canonicalDomain}", Resolved Name: "${canonicalCompany}"`);

  const defaultEntityConfidence = source === 'manual' ? 1 : 0.4;
  const entityConfidence = parseConfidenceScore(result.entity_confidence ?? result.entityConfidence ?? defaultEntityConfidence);
  vLog(`[NORMALIZER] Verified Entity Confidence Rating: ${entityConfidence}`);

  const primaryApplicationUrl = sanitizeUrl(result.primary_application_url || result.primaryApplicationUrl || getMetadataValue(metadata, 'Job URL'));
  const atsPlatform = oneLinePlainText(result.ats_platform || result.atsPlatform || getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(primaryApplicationUrl));

  const candidateInputs =[];
  if (result.best_email || result.bestEmail) candidateInputs.push(result.best_email || result.bestEmail);
  asArray(result.all_candidates || result.allCandidates).forEach(c => candidateInputs.push(c));

  const candidates =[];
  const seenEmails = {};

  candidateInputs.forEach(candidateInput => {
    const normalizedCandidate = normalizeDiscoveryCandidate(candidateInput, { metadata, canonicalCompany, canonicalDomain, entityConfidence, primaryApplicationUrl, atsPlatform });
    if (!normalizedCandidate.email) return;

    if (seenEmails[normalizedCandidate.email]) {
      mergeCandidateEvidence(seenEmails[normalizedCandidate.email], normalizedCandidate);
    } else {
      seenEmails[normalizedCandidate.email] = normalizedCandidate;
      candidates.push(normalizedCandidate);
    }
  });

  const suppressedCandidates = asArray(result.suppressed_candidates || result.suppressedCandidates)
    .map(normalizeSuppressedCandidate).filter(c => c.email || c.reason);

  const sortedCandidates = candidates.sort((a, b) => b.score - a.score);
  
  // Tag ALL candidates that meet the threshold for drafting
  finalizeCandidateActions(sortedCandidates, entityConfidence);

  const logCandidates = sortedCandidates.slice(0, MAX_DISCOVERY_CANDIDATES_TO_LOG);
  if (logCandidates.length > 0) {
    logCandidates.forEach((candidate, idx) => {
      vLog(`  - [DISCOVERY] Ranked Candidate #${idx + 1}: ${candidate.email} | tier=${candidate.tier} | score=${candidate.score} | action=${candidate.recommendedAction}`);
    });
  } else {
    vLog('  - [DISCOVERY] No valid candidates survived normalization.');
  }
  
  const draftableCandidates = sortedCandidates.filter(c => c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT);
  const bestCandidate = draftableCandidates.length > 0 ? draftableCandidates[0] : null;
  const score = bestCandidate ? bestCandidate.score : 0;

  const normalized = {
    companyMailingAddress,
    canonicalCompany,
    canonicalDomain,
    entityConfidence,
    entityNotes: cleanLlmText(result.entity_notes || result.entityNotes || ''),
    primaryApplicationUrl,
    atsPlatform,
    candidates: sortedCandidates,
    allCandidates: sortedCandidates,
    suppressedCandidates,
    bestCandidate,
    bestEmail: bestCandidate ? bestCandidate.email : '',
    score,
    confidenceLabel: scoreToLabel(score),
    shouldCreateDraft: draftableCandidates.length > 0,
    notes: cleanLlmText(result.notes || '')
  };

  if (!normalized.notes && !bestCandidate) normalized.notes = 'No draftable public professional email candidate was found.';
  if (entityConfidence < APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE) {
    vLog(`[NORMALIZER] [WARNING] Trust validation fallback: Entity confidence (${entityConfidence}) below limit threshold. Bypassing automatic generation.`);
    normalized.shouldCreateDraft = false;
    normalized.notes = appendSentence(normalized.notes, `Entity confidence is below threshold (${entityConfidence}). Draft creation suppressed.`);
  }

  return normalized;
}

/**
 * Normalizes one candidate.
 */
function normalizeDiscoveryCandidate(candidateInput, context) {
  const raw = typeof candidateInput === 'string' ? { email: candidateInput } : (candidateInput || {});
  const email = sanitizeEmailAddress(raw.email || raw.address || '');
  const localPart = getEmailLocalPart(email);
  const evidenceUrls = asArray(raw.evidence_urls || raw.evidenceUrls).map(sanitizeUrl).filter(Boolean);

  const evidenceSummary = cleanLlmText(raw.evidence_summary || raw.evidenceSummary || raw.reason || '');
  const caveat = cleanLlmText(raw.caveat || raw.notes || '');
  const sourceType = normalizeSourceType(raw.source_type || raw.sourceType || raw.source || 'unknown');
  const reportedTier = normalizeDiscoveryTier(raw.tier || raw.category || '');
  const reportedScore = parseScoreTo100(raw.score || raw.confidence_score || raw.confidence || 0);

  let tier = reportedTier || classifyCandidateTier(email, { evidenceSummary, caveat, sourceType });
  let recommendedAction = DISCOVERY_ACTIONS.BACKUP_ONLY;
  let suppressionReason = '';

  if (!email || !isValidEmailAddress(email)) {
    tier = DISCOVERY_TIERS.SUPPRESSED;
    recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
  } else {
    suppressionReason = getSuppressionReasonForEmail(email, { evidenceSummary, caveat, sourceType, tier });
    if (suppressionReason) {
      tier = DISCOVERY_TIERS.SUPPRESSED;
      recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    } else if (tier === DISCOVERY_TIERS.SUPPRESSED && isRecruitingOrCareerLocalPart(localPart)) {
      tier = DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT;
    } else if (tier === DISCOVERY_TIERS.SUPPRESSED) {
      recommendedAction = DISCOVERY_ACTIONS.SUPPRESS;
    }
  }

  const score = recommendedAction === DISCOVERY_ACTIONS.SUPPRESS ? 0 : computeCandidateScore({ email, tier, sourceType, evidenceUrls, evidenceSummary, caveat, reportedScore, context });
  if (recommendedAction !== DISCOVERY_ACTIONS.SUPPRESS) recommendedAction = actionForScore(score);

  vLog(`  - [DISCOVERY MODULE] Candidate Evaluator: "${email}": Category Tier=${tier}, Priority Rating=${score}, Routing Decision=${recommendedAction}`);
  return { email, tier, score, sourceType, evidenceUrls, evidenceSummary, caveat, recommendedAction, suppressionReason };
}

/**
 * Computes a deterministic score.
 */
function computeCandidateScore(candidate) {
  if (!candidate.email || !isValidEmailAddress(candidate.email)) return 0;

  // FIX (Bug 2): Use the LLM's reportedScore as a gentle directional hint only,
  // not as a fixed anchor. Dampening to 30% weight prevents a model that always
  // returns the same value (e.g. 0.92) from freezing every score at that number
  // before the deterministic bonuses/penalties are even applied.
  let score = candidate.reportedScore > 0
    ? 35 + Math.round((candidate.reportedScore - 35) * 0.3)
    : 35;

  const localPart = getEmailLocalPart(candidate.email);
  const emailDomain = normalizeDomain(candidate.email.split('@')[1]);
  const canonicalDomain = normalizeDomain(candidate.context.canonicalDomain);
  const evidenceText = `${candidate.evidenceSummary} ${candidate.caveat} ${candidate.sourceType}`.toLowerCase();

  if (canonicalDomain && domainMatchesOrSubdomain(emailDomain, canonicalDomain)) score += 18;
  else if (canonicalDomain && emailDomain && !domainLooksLikePublicEmailProvider(emailDomain)) score -= 10;

  if (candidate.sourceType === 'official_careers_page' || candidate.sourceType === 'official_job_posting') score += 18;
  else if (candidate.sourceType === 'official_company_page') score += 14;
  else if (candidate.sourceType === 'ats_page') score += 10;
  else if (candidate.sourceType === 'heuristic_pattern') score -= 12;
  else if (candidate.sourceType === 'third_party') score -= 28;

  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE) score += 25;
  else if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT) score += 18;
  else if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_GENERAL_CONTACT) score += 8;

  if (isRecruitingOrCareerLocalPart(localPart)) score += 15;
  if (/\b(not for applications|do not send)\b/i.test(evidenceText)) score -= 35;
  if (candidate.context.entityConfidence < APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE) score -= 40;

  // Penalize candidates backed by zero documentary evidence.
  if (!candidate.evidenceUrls || candidate.evidenceUrls.length === 0) score -= 12;

  return applyCandidateScoreCaps(Math.round(score), candidate);
}

function applyCandidateScoreCaps(score, candidate) {
  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE) return Math.max(0, Math.min(100, score));
  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT) return Math.max(0, Math.min(95, score));
  if (candidate.tier === DISCOVERY_TIERS.OFFICIAL_GENERAL_CONTACT) return Math.max(0, Math.min(90, score));
  return Math.max(0, Math.min(84, score));
}

function mergeCandidateEvidence(target, incoming) {
  target.score = Math.max(target.score, incoming.score);
  if (incoming.tier && tierRank(incoming.tier) > tierRank(target.tier)) target.tier = incoming.tier;
  target.evidenceUrls = Array.from(new Set([].concat(target.evidenceUrls || [], incoming.evidenceUrls || [])));
  if (incoming.evidenceSummary && !target.evidenceSummary.includes(incoming.evidenceSummary)) target.evidenceSummary = appendSentence(target.evidenceSummary, incoming.evidenceSummary);
  target.recommendedAction = actionForScore(target.score);
}

function finalizeCandidateActions(candidates, entityConfidence) {
  candidates.forEach(candidate => {
    if (candidate.recommendedAction === DISCOVERY_ACTIONS.SUPPRESS) return;
    candidate.recommendedAction = shouldCreateDraftForCandidate(candidate, entityConfidence)
      ? DISCOVERY_ACTIONS.CREATE_DRAFT
      : DISCOVERY_ACTIONS.BACKUP_ONLY;
  });
}

function shouldCreateDraftForCandidate(candidate, entityConfidence) {
  if (!ENABLE_EMAIL_DISPATCH || APPLICATION_DRAFT_MODE === 'OFF' || !candidate || entityConfidence < APPLICATION_EMAIL_MIN_ENTITY_CONFIDENCE) return false;
  if (candidate.recommendedAction === DISCOVERY_ACTIONS.SUPPRESS) return false;
  if (APPLICATION_DRAFT_MODE === 'VERIFIED_ONLY') return candidate.score >= APPLICATION_EMAIL_HIGH_SCORE;
  if (APPLICATION_DRAFT_MODE === 'MEDIUM_PLUS') return candidate.score >= APPLICATION_EMAIL_MEDIUM_SCORE;
  return candidate.score >= APPLICATION_EMAIL_HAIL_MARY_SCORE;
}

function actionForScore(score) {
  if (score >= APPLICATION_EMAIL_HAIL_MARY_SCORE) return DISCOVERY_ACTIONS.CREATE_DRAFT;
  if (score > 0) return DISCOVERY_ACTIONS.BACKUP_ONLY;
  return DISCOVERY_ACTIONS.SUPPRESS;
}

// Simple mapping conversion
function scoreToLabel(score) {
  if (score >= APPLICATION_EMAIL_HIGH_SCORE) return 'HIGH';
  if (score >= APPLICATION_EMAIL_MEDIUM_SCORE) return 'MEDIUM';
  if (score >= APPLICATION_EMAIL_HAIL_MARY_SCORE) return 'LOW';
  return 'NONE';
}

function normalizeSuppressedCandidate(candidate) {
  if (typeof candidate === 'string') return { email: sanitizeEmailAddress(candidate), reason: '' };
  return { email: sanitizeEmailAddress(candidate.email || ''), reason: cleanLlmText(candidate.reason || '') };
}

function associateApplicationEmailDiscovery(metadata, result) {
  const bestCandidate = result.bestCandidate || null;
  metadata['Application Email Discovery Status'] = result.shouldCreateDraft ? 'DRAFTABLE_EMAIL_FOUND' : 'NO_DRAFTABLE_EMAIL_FOUND';
  metadata['Application Email'] = bestCandidate ? bestCandidate.email : '';
  metadata['Application Email Score'] = String(result.score || 0);
  metadata['Application Email Tier'] = bestCandidate ? bestCandidate.tier : '';
}

function annotateGeneratedFilesWithApplicationEmail(files, metadata, discoveryResult) {
  if (!ANNOTATE_DRIVE_FILES_WITH_DISCOVERY || !files || !files.length) return;
  vLog(`[FILE META] Appending tracking notes and evidence to generated files...`);
  
  const candidates = asArray(discoveryResult && discoveryResult.candidates);
  const draftableEmails = candidates
    .filter(c => c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT)
    .slice(0, MAX_DISCOVERY_CANDIDATES_TO_ANNOTATE)
    .map(c => `${c.email} (${c.score}/100)`)
    .join(', ');

  const emailLine = draftableEmails ? `Target Emails: ${draftableEmails}` : 'Target Emails: NONE';

  const lines =[
    'Application email discovery:',
    `Status: ${getMetadataValue(metadata, 'Application Email Discovery Status') || 'UNKNOWN'}`,
    `Canonical Domain: ${discoveryResult.canonicalDomain || 'UNKNOWN'}`,
    emailLine
  ].join('\n');
  
  files.forEach(file => {
    vLog(`  - [FILE META] Appending annotation parameters to file: "${file.getName()}" (ID: ${file.getId()})`);
    appendDriveFileDescription(file, lines);
  });
}

function appendDriveFileDescription(file, note) {
  try {
    const existing = String(file.getDescription() || '').trim();
    let combined = `${existing}${existing ? '\n\n---\n' : ''}${note}`;
    if (combined.length > 4900) {
      // Truncate the OLD text from the top so the new note is always visible at the bottom
      const excess = combined.length - 4900;
      combined = '...' + combined.substring(excess + 3);
    }
    file.setDescription(combined);
  } catch (e) {
    vLog(`Warning: Failed to append file description to ${file.getId()}: ${e.message}`);
  }
}

function getFullDocumentText(doc) {
  let text = '';
  [doc.getHeader(), doc.getBody(), doc.getFooter()].forEach(container => {
    if (container) text += container.getText().replace(/\r\n/g, '\n').replace(/[\r\v]/g, '\n').trim() + '\n\n\n';
  });
  return text.replace(/([^\n])\n+(Dear\s|To\s|Greetings|Hi\s)/gi, '$1\n\n$2').trim();
}

/**
 * Dispatches application mail independently from the core material pipeline.
 * Returns a 1:1 result for every intended recipient, including suppressed and failed targets.
 */
function dispatchApplicationEmail(metadata, fullCoverLetterText, resumeFile, discoveryResult, config) {
  vLog('[EMAIL ENGINE] Preparing recipient-level dispatch packets...');
  if (!ENABLE_EMAIL_DISPATCH) throw new Error('Email dispatch is disabled.');

  let initialEmails = asArray(discoveryResult && discoveryResult.candidates)
    .filter(c => c && c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT)
    .map(c => sanitizeEmailAddress(c.email))
    .filter(Boolean);

  if (initialEmails.length === 0) {
    const fallback = sanitizeEmailAddress(getMetadataValue(metadata, 'Application Email'));
    if (fallback) initialEmails.push(fallback);
  }
  initialEmails = [...new Set(initialEmails)];

  if (initialEmails.length === 0) {
    return { recipientResults: [], targetEmails: [], isSent: AUTO_SEND_EMAILS, getId: () => '' };
  }

  const bouncedAddresses = getBouncedAddressSet();
  const recipientResults = [];
  const activeEmails = [];
  initialEmails.forEach(email => {
    if (bouncedAddresses.has(email)) {
      recipientResults.push({ email, status: LOG_STATUS_SUPPRESSED_BOUNCE, messageId: '', error: 'Previously confirmed permanent bounce.' });
      vLog(`[EMAIL ENGINE] [BOUNCE SUPPRESSION] Suppressing permanently bounced address: ${email}`);
    } else {
      activeEmails.push(email);
    }
  });

  if (activeEmails.length === 0) {
    return {
      recipientResults: orderDispatchResults(initialEmails, recipientResults),
      targetEmails: initialEmails,
      isSent: AUTO_SEND_EMAILS,
      getId: () => ''
    };
  }

  const subject = buildApplicationEmailSubject(metadata, config);
  const basePlainBody = formatCoverLetterPlaintext(fullCoverLetterText);
  const baseHtmlBody = formatCoverLetterHtml(fullCoverLetterText);
  const transparencyFooterProfile = classifyApplicationTransparencyRole(metadata);
  const plainFooter = ENABLE_APPLICATION_TRANSPARENCY_FOOTER ? buildApplicationTransparencyFooterPlaintext(metadata) : '';
  const htmlFooter = ENABLE_APPLICATION_TRANSPARENCY_FOOTER ? buildApplicationTransparencyFooterHtml(metadata) : '';
  const plainBody = plainFooter ? `${basePlainBody}\n\n${plainFooter}` : basePlainBody;
  const htmlBody = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #202124;">${baseHtmlBody}${htmlFooter}</div>`;
  const options = { name: config.applicantName, replyTo: config.applicantEmail, htmlBody };
  if (ENABLE_APPLICATION_TRANSPARENCY_FOOTER) {
    vLog(`[EMAIL ENGINE] Added Astro transparency footer (profile=${transparencyFooterProfile}).`);
  }

  if (canUseGmailFromAddress(config.applicantEmail)) {
    options.from = config.applicantEmail;
  } else if (STRICT_GMAIL_FROM_VALIDATION) {
    throw new Error(`Configured APPLICANT_EMAIL is not an authorized Gmail From address: ${config.applicantEmail}`);
  } else {
    vLog('[EMAIL ENGINE] [WARNING] Configured APPLICANT_EMAIL is not an authorized Gmail From alias. Using account default sender and preserving replyTo.');
  }

  if (ATTACH_RESUME_PDF && resumeFile) {
    const cleanResumeBaseName = safeFilename(resumeFile.getName()).replace(/\.pdf$/i, '');
    options.attachments = [resumeFile.getAs(MimeType.PDF).setName(`${cleanResumeBaseName}.pdf`)];
  }

  if (AUTO_SEND_EMAILS) {
    try {
      GmailApp.sendEmail(activeEmails.join(', '), subject, plainBody, options);
      activeEmails.forEach(email => recipientResults.push({ email, status: 'SENT', messageId: 'SENT_AUTOMATICALLY', error: '' }));
      RUN_METRICS.emailsSent += activeEmails.length;
      vLog(`[EMAIL ENGINE] Bulk send succeeded for ${activeEmails.length} recipient(s).`);
    } catch (bulkError) {
      vLog(`[EMAIL ENGINE] [WARNING] Bulk send failed ("${bulkError.message}"). Attempting per-recipient sends.`);
      activeEmails.forEach(email => {
        try {
          GmailApp.sendEmail(email, subject, plainBody, options);
          recipientResults.push({ email, status: 'SENT', messageId: 'SENT_AUTOMATICALLY', error: '' });
          RUN_METRICS.emailsSent++;
          vLog(`[EMAIL ENGINE] Successfully sent email to: ${email}`);
        } catch (singleErr) {
          recipientResults.push({ email, status: LOG_STATUS_DISPATCH_FAILED, messageId: '', error: singleErr.message || 'Send failed' });
          vLog(`[EMAIL ENGINE] Failed sending email to ${email}: ${singleErr.message}`);
        }
      });
    }
  } else {
    try {
      const draft = GmailApp.createDraft(activeEmails.join(', '), subject, plainBody, options);
      const draftId = draft.getId();
      activeEmails.forEach(email => recipientResults.push({ email, status: 'DRAFTED', messageId: draftId, error: '' }));
      RUN_METRICS.emailsDrafted += activeEmails.length;
      vLog(`[EMAIL ENGINE] Bulk draft created successfully. Draft ID: ${draftId}`);
    } catch (bulkError) {
      vLog(`[EMAIL ENGINE] [WARNING] Bulk draft creation failed ("${bulkError.message}"). Attempting per-recipient drafts.`);
      activeEmails.forEach(email => {
        try {
          const draft = GmailApp.createDraft(email, subject, plainBody, options);
          recipientResults.push({ email, status: 'DRAFTED', messageId: draft.getId(), error: '' });
          RUN_METRICS.emailsDrafted++;
          vLog(`[EMAIL ENGINE] Successfully created draft for: ${email}`);
        } catch (singleErr) {
          recipientResults.push({ email, status: LOG_STATUS_DISPATCH_FAILED, messageId: '', error: singleErr.message || 'Draft creation failed' });
          vLog(`[EMAIL ENGINE] Failed creating draft for ${email}: ${singleErr.message}`);
        }
      });
    }
  }

  const ordered = orderDispatchResults(initialEmails, recipientResults);
  return {
    recipientResults: ordered,
    targetEmails: initialEmails,
    isSent: AUTO_SEND_EMAILS,
    from: options.from || '',
    getId: () => ordered.map(r => r.messageId || '').filter(Boolean).join(', ')
  };
}

function orderDispatchResults(initialEmails, recipientResults) {
  const byEmail = {};
  asArray(recipientResults).forEach(result => { if (result && result.email) byEmail[result.email] = result; });
  return asArray(initialEmails).map(email => byEmail[email] || {
    email,
    status: LOG_STATUS_DISPATCH_FAILED,
    messageId: '',
    error: 'No dispatch result was returned.'
  });
}

function buildApplicationEmailSubject(metadata, config) {
  const jobTitle = oneLinePlainText(getBestJobTitle(metadata));
  const jobId = oneLinePlainText(getMetadataValue(metadata, 'Job ID'));
  let subject = jobTitle ? `${jobTitle} Application — ${config.applicantName}` : `Application — ${config.applicantName}`;
  if (jobId) subject += ` — ${jobId}`;
  return truncateSubject(subject, 160);
}

function formatCoverLetterPlaintext(text) {
  return decodeCommonHtmlEntities(String(text || '')).replace(/\r\n?/g, '\n').replace(/<[^>]+>/g, '').trim();
}

function formatCoverLetterHtml(text) {
  return String(text || '').split(/\n{2,}/).map(p => {
    if (!p.trim()) return '';
    const escaped = escapeHtml(p).replace(/\n/g, '<br>');
    return `<p style="margin-bottom: 1.2em; line-height: 1.5; margin-top: 0;">${escaped}</p>`;
  }).filter(Boolean).join('\n');
}

function classifyApplicationTransparencyRole(metadata) {
  const titleSignals = [
    oneLinePlainText(getBestJobTitle(metadata)),
    oneLinePlainText(getMetadataValue(metadata, 'Professional Title'))
  ].filter(Boolean).join(' ');

  const securityRolePattern = /(?:\bsecurity\b|\bcyber(?:security)?\b|\binfosec\b|\bsecops\b|\bSOC\b|\bthreat\b|\bvulnerabilit(?:y|ies)\b|\bincident response\b|\bdetection(?:\s+(?:and|&))?\s+response\b|\bsecurity operations\b|\bidentity(?:\s+(?:and|&))?\s+access\b|\bIAM\b|\bendpoint security\b)/i;
  return securityRolePattern.test(titleSignals) ? 'SECURITY' : 'IT_SUPPORT';
}

function buildApplicationTransparencyFooterText(metadata) {
  const profile = classifyApplicationTransparencyRole(metadata);
  const deliveryDetail = profile === 'SECURITY'
    ? ', including delivery tracking and bounce handling'
    : '';

  return [
    'I built AstroOM, an AI-assisted system that helps me identify relevant opportunities and prepare tailored application materials.',
    `I also built the Google Apps Script workflow that generated and delivered this application${deliveryDetail}.`,
    'I personally review and approve every application.'
  ].join(' ');
}

function buildApplicationTransparencyFooterPlaintext(metadata) {
  const text = buildApplicationTransparencyFooterText(metadata);
  return `---\nBuilt with Astro:\n${text}\nAstroOM on GitHub: ${ASTRO_PROJECT_URL}`;
}

function buildApplicationTransparencyFooterHtml(metadata) {
  const text = escapeHtml(buildApplicationTransparencyFooterText(metadata));
  const projectUrl = escapeHtml(ASTRO_PROJECT_URL);
  return [
    '<div style="margin-top: 1.6em; padding-top: 0.9em; border-top: 1px solid #dadce0; font-size: 11px; line-height: 1.45; color: #5f6368;">',
    '<strong style="color: #3c4043;">Built with Astro:</strong> ',
    text,
    ` <a href="${projectUrl}" style="color: #5f6368;">AstroOM on GitHub</a>`,
    '</div>'
  ].join('');
}

function normalizeDiscoveryTier(tier) {
  const normalized = String(tier || '').trim().toUpperCase();
  if (!normalized) return '';
  if (DISCOVERY_TIERS[normalized]) return DISCOVERY_TIERS[normalized];
  if (/application|resume/.test(normalized.toLowerCase())) return DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE;
  return '';
}

function classifyCandidateTier(email, context) {
  const localPart = getEmailLocalPart(email);
  if (/^(careers?|jobs?|apply|resume|cv)$/i.test(localPart)) return DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE;
  if (isRecruitingOrCareerLocalPart(localPart)) return DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT;
  return DISCOVERY_TIERS.OTHER_PUBLIC_ROUTE;
}

function isRecruitingOrCareerLocalPart(localPart) {
  return /^(careers?|jobs?|apply|resume|recruiting|recruitment|talent|talentacquisition|ta|hiring|hr|people)$/i.test(String(localPart || '').trim());
}

function normalizeSourceType(sourceType) {
  const value = String(sourceType || '').trim().toLowerCase();
  if (/ats|workday|greenhouse|lever|ashby|smartrecruiters|icims|jobvite|taleo|breezy|bamboohr|rippling/.test(value)) return 'ats_page';
  if (/career|careers|hiring[-_\s]?page/.test(value))                             return 'official_careers_page';
  if (/job[_\s-]?posting|job[_\s-]?page|posting/.test(value))                     return 'official_job_posting';
  if (/official[_\s-]?site|company|homepage|website/.test(value))                 return 'official_company_page';
  if (/third.?party|aggregator/.test(value))                                       return 'third_party';
  if (/professional|linkedin|recruiter|people[_\s-]?profile/.test(value))         return 'public_professional_page';
  if (/heuristic|pattern|synthetic/.test(value))                                   return 'heuristic_pattern';
  if (/manual|provided/.test(value))                                               return 'manual';
  return 'unknown';
}

function getSuppressionReasonForEmail(email, context) {
  if (!email || !isValidEmailAddress(email)) return 'Invalid email.';
  const localPart = getEmailLocalPart(email);
  if (/(no-reply|noreply|donotreply|privacy|abuse|legal|billing|press|media|investor|postmaster|webmaster|security|accommodation|accessibility|sales)/.test(localPart)) {
    return `Suppressed local part: ${localPart}`;
  }
  return '';
}

function parseConfidenceScore(value) {
  const number = Number(String(value).replace('%', '')) || 0;
  return number > 1 ? Math.max(0, Math.min(1, number / 100)) : Math.max(0, Math.min(1, number));
}

function parseScoreTo100(value) {
  const number = Number(String(value).replace('%', '')) || 0;
  return number <= 1 && number > 0 ? Math.round(number * 100) : Math.max(0, Math.min(100, Math.round(number)));
}

function tierRank(tier) {
  if (tier === DISCOVERY_TIERS.OFFICIAL_APPLICATION_INTAKE) return 5;
  if (tier === DISCOVERY_TIERS.OFFICIAL_RECRUITING_OR_CANDIDATE_SUPPORT) return 4;
  if (tier === DISCOVERY_TIERS.OFFICIAL_GENERAL_CONTACT) return 3;
  if (tier === DISCOVERY_TIERS.PUBLIC_RECRUITER_OR_HIRING_TEAM) return 2;
  if (tier === DISCOVERY_TIERS.OTHER_PUBLIC_ROUTE) return 1;
  return 0;
}

function detectAtsPlatform(url) {
  const text = String(url || '').toLowerCase();
  if (text.includes('workday')) return 'Workday';
  if (text.includes('greenhouse')) return 'Greenhouse';
  if (text.includes('lever')) return 'Lever';
  if (text.includes('ashby')) return 'Ashby';
  if (text.includes('smartrecruiters')) return 'SmartRecruiters';
  if (text.includes('icims')) return 'iCIMS';
  if (text.includes('jobvite')) return 'Jobvite';
  if (text.includes('taleo')) return 'Taleo';
  if (text.includes('breezy')) return 'Breezy HR';
  if (text.includes('bamboohr')) return 'BambooHR';
  if (text.includes('rippling')) return 'Rippling';
  return '';
}

/**
 * Single-Pass Template Replacement Engine.
 */
function applyTemplateReplacements(doc, replacements) {
  vLog(`[TEMPLATE ENGINE] Initializing single-pass text replacements...`);
  const containers =[doc.getHeader(), doc.getBody(), doc.getFooter()].filter(Boolean);
  containers.forEach((container, containerIdx) => {
    vLog(`  - [TEMPLATE ENGINE] Parsing container zone #${containerIdx + 1}`);
    for (const [literal, replacement] of Object.entries(replacements)) {
      replaceAllLiteralText(container, literal, replacement);
    }
  });
}

function generateResumeDoc(resumeTemplate, targetFolder, metadata) {
  const manualResumeName = getMetadataValue(metadata, 'Resume Filename') || getMetadataValue(metadata, 'Materials Filename');
  const resumeName = manualResumeName ? manualResumeName : `${getMetadataValue(metadata, 'Job ID')} - Resume for ${getMetadataValue(metadata, 'Company')}`;
  
  vLog(`[RESUME GENERATOR] Manual Name Check: ${manualResumeName ? 'Found Name Override: ' + manualResumeName : 'Not found. Defaulting to standard metadata layout.'}`);
  vLog(`[RESUME GENERATOR] target file name verified: "${resumeName}"`);
  
  if (REUSE_EXISTING_GENERATED_FILES) {
    const existing = findFileByExactNameInFolder(targetFolder, resumeName);
    if (existing) {
      vLog(`[RESUME GENERATOR] Reuse flags enabled. Found matching template match ID: ${existing.getId()}`);
      return existing;
    }
  }

  vLog(`[RESUME GENERATOR] Replicating Template ID: ${resumeTemplate.getId()}`);
  const newResumeFile = resumeTemplate.makeCopy(resumeName, targetFolder);
  const newResumeDoc = DocumentApp.openById(newResumeFile.getId());
  vLog(`[RESUME GENERATOR] Copied custom instance. Doc ID: ${newResumeFile.getId()}`);

  const replacements = {};
  replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_PROF_TITLE] = getMetadataValue(metadata, 'Professional Title');
  replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_PROF_SUMMARY] = getMetadataValue(metadata, 'Professional Summary');
  replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_SKILLS] = getMetadataValue(metadata, 'Key Skills');
  
  const jobUrl = getMetadataValue(metadata, 'Job URL');

  // Defer clearing JOB_URL if we intend to inject a hyperlink there
  if (!jobUrl || !INCLUDE_VISIBLE_JOB_URL_IN_RESUME) {
    replacements[TEMPLATE_PLACEHOLDERS.JOB_URL] = ''; 
  }

  applyTemplateReplacements(newResumeDoc, replacements);

  if (jobUrl && INCLUDE_VISIBLE_JOB_URL_IN_RESUME) {
    vLog('[RESUME GENERATOR] Injecting visible Job URL into Resume...');
    replaceFirstLiteralTextWithLinkEverywhere(newResumeDoc, TEMPLATE_PLACEHOLDERS.JOB_URL, VISIBLE_JOB_URL_LABEL, jobUrl);
  }
  assertTemplatePlaceholdersResolved(newResumeDoc, 'Resume');

  vLog('[RESUME GENERATOR] Normalizing and removing parsing star markers...');
  removeStarLabels(newResumeDoc.getBody());
  normalizeResumeHeaderTop(newResumeDoc);
  
  newResumeDoc.saveAndClose();
  vLog('[RESUME GENERATOR] File saved and locked.');
  return newResumeFile;
}

function generateCoverLetterDoc(coverTemplate, targetFolder, metadata, coverLetterContent) {
  const manualCoverName = getMetadataValue(metadata, 'Cover Letter Filename');
  const coverName = manualCoverName ? manualCoverName : `${getMetadataValue(metadata, 'Job ID')} - Cover Letter for ${getMetadataValue(metadata, 'Company')}`;
  
  vLog(`[COVER LETTER GENERATOR] Manual Name Check: ${manualCoverName ? 'Found Name Override: ' + manualCoverName : 'Not found. Defaulting to standard metadata layout.'}`);
  vLog(`[COVER LETTER GENERATOR] Target file name verified: "${coverName}"`);
  
  let newCoverFile;

  if (REUSE_EXISTING_GENERATED_FILES) {
    newCoverFile = findFileByExactNameInFolder(targetFolder, coverName);
    if (newCoverFile) vLog(`[COVER LETTER GENERATOR] Reuse tags match. Found Cover Letter template ID: ${newCoverFile.getId()}`);
  }

  if (!newCoverFile) {
    vLog(`[COVER LETTER GENERATOR] Replicating Cover Letter Template ID: ${coverTemplate.getId()}`);
    newCoverFile = coverTemplate.makeCopy(coverName, targetFolder);
    const newCoverDoc = DocumentApp.openById(newCoverFile.getId());
    vLog(`[COVER LETTER GENERATOR] Copied custom instance. Doc ID: ${newCoverFile.getId()}`);

    const replacements = {};
    replacements[TEMPLATE_PLACEHOLDERS.CUSTOM_PROF_TITLE] = getMetadataValue(metadata, 'Professional Title');
    replacements[TEMPLATE_PLACEHOLDERS.TODAYS_DATE] = getTodaysDateString();
    const coverCompany = getMetadataValue(metadata, 'Company');
    const coverAddress = getMetadataValue(metadata, 'Company Address');
    const coverTemplateText = getFullDocumentText(newCoverDoc);
    const companyPlaceholderIndex = coverTemplateText.indexOf(TEMPLATE_PLACEHOLDERS.JOB_COMPANY);
    const addressPlaceholderIndex = coverTemplateText.indexOf(TEMPLATE_PLACEHOLDERS.JOB_COMPANY_ADDRESS);
    const betweenCompanyAndAddress = companyPlaceholderIndex >= 0 && addressPlaceholderIndex > companyPlaceholderIndex
      ? coverTemplateText.slice(companyPlaceholderIndex + TEMPLATE_PLACEHOLDERS.JOB_COMPANY.length, addressPlaceholderIndex)
      : '';
    const companyAlreadyImmediatelyAboveAddress = companyPlaceholderIndex >= 0 && addressPlaceholderIndex > companyPlaceholderIndex && /^\s*$/.test(betweenCompanyAndAddress);
    const coverCompanyAddressBlock = companyAlreadyImmediatelyAboveAddress
      ? coverAddress
      : [coverCompany, coverAddress].filter(Boolean).join('\n');
    replacements[TEMPLATE_PLACEHOLDERS.JOB_COMPANY_ADDRESS] = coverCompanyAddressBlock;
    replacements[TEMPLATE_PLACEHOLDERS.JOB_COMPANY] = coverCompany;
    replacements[TEMPLATE_PLACEHOLDERS.COVER_BODY] = coverLetterContent || '';

    applyTemplateReplacements(newCoverDoc, replacements);
    assertTemplatePlaceholdersResolved(newCoverDoc, 'Cover Letter');
    const coverText = getFullDocumentText(newCoverDoc);
    newCoverDoc.saveAndClose();
    vLog('[COVER LETTER GENERATOR] File saved and locked.');
    return { file: newCoverFile, text: coverText };
  }

  const reopenedDoc = DocumentApp.openById(newCoverFile.getId());
  const coverText = getFullDocumentText(reopenedDoc);
  reopenedDoc.saveAndClose();
  return { file: newCoverFile, text: coverText };
}

/**
 * Extracts the trailing segment of the manual file name.
 */
function getRearJobTitlePortion(metadata) {
  const resumeFilename = getMetadataValue(metadata, 'Resume Filename') || getMetadataValue(metadata, 'Materials Filename');
  const coverFilename = getMetadataValue(metadata, 'Cover Letter Filename');
  const sourceName = resumeFilename || coverFilename;
  
  if (!sourceName) {
    // Structural fallback: Use Job ID or compressed job title
    const jobId = getMetadataValue(metadata, 'Job ID');
    if (jobId) return jobId;
    const jobTitle = getBestJobTitle(metadata);
    return jobTitle ? jobTitle.replace(/[^a-zA-Z0-9]/g, '') : 'Job';
  }
  
  // Matches trailing characters after _Resume_ or _Cover_ or _Materials_
  const match = sourceName.match(/_(?:Resume|Cover|Materials)_(.+)$/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  
  // Secondary fallback: Extract final string split by underscore
  const parts = sourceName.split('_');
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (!/^(resume|cover|materials)$/i.test(last)) {
      return last.trim();
    }
  }
  return sourceName;
}

/**
 * Computes the base name for the LinkedIn document and rendered .desktop file.
 */
function getLinkedInDocBaseName(metadata, config) {
  const rearPortion = getRearJobTitlePortion(metadata).replace(/\.pdf$/i, '');
  const applicantName = (config && config.applicantName) ? config.applicantName : 'Michael Martini';
  const applicantPrefix = applicantName.replace(/[^\w]/g, '_');
  return `${applicantPrefix}_LinkedIn_${rearPortion}`;
}

/**
 * Derives a concise, human-readable posting name for the KDE Plasma .desktop shortcut.
 */
function getHumanReadablePostingName(metadata) {
  const company = oneLinePlainText(getMetadataValue(metadata, 'Company'));
  const title = oneLinePlainText(getBestJobTitle(metadata));
  if (company && title) return `${company} - ${title}`;
  if (title) return title;
  if (company) return `${company} - Job Posting`;
  return 'LinkedIn Job Posting';
}

/**
 * Generates the third output file containing the LinkedIn posting URL.
 */
function generateLinkedInDoc(targetFolder, metadata, jobUrl, config) {
  const linkedInFileName = getLinkedInDocBaseName(metadata, config);
  vLog(`[LINKEDIN DOC GENERATOR] Preparing creation of: "${linkedInFileName}"...`);
  
  if (REUSE_EXISTING_GENERATED_FILES) {
    const existing = findFileByExactNameInFolder(targetFolder, linkedInFileName);
    if (existing) {
      vLog(`[LINKEDIN DOC GENERATOR] Reusing existing generated LinkedIn Doc ID: ${existing.getId()}`);
      return existing;
    }
  }

  // Create temporary document container in root and shift to target folder
  const newDoc = DocumentApp.create(linkedInFileName);
  const body = newDoc.getBody();
  
  // Clean initial empty paragraph if present
  const firstParagraph = body.getParagraphs()[0];
  if (firstParagraph && firstParagraph.getText() === '') {
    firstParagraph.editAsText().setText("LinkedIn Job Posting URL:");
    if (firstParagraph.setBold) firstParagraph.setBold(true);
  } else {
    const p = body.appendParagraph("LinkedIn Job Posting URL:");
    if (p && p.setBold) p.setBold(true);
  }
  const linkParagraph = body.appendParagraph(jobUrl);
  linkParagraph.setLinkUrl(jobUrl);
  newDoc.saveAndClose();

  const file = DriveApp.getFileById(newDoc.getId());
  file.moveTo(targetFolder);
  
  vLog(`[LINKEDIN DOC GENERATOR] New Doc generated and shifted to target folder. Doc ID: ${file.getId()}`);
  return file;
}

/**
 * Computes a standardized folder name for an application's rendered package materials.
 */
function getRenderPackageFolderName(metadata, config) {
  const applicantName = (config && config.applicantName) ? config.applicantName : 'Michael Martini';
  const applicantPrefix = applicantName.replace(/[^\w]/g, '_');

  const manualResumeName = getMetadataValue(metadata, 'Resume Filename') || getMetadataValue(metadata, 'Materials Filename');
  const manualCoverName = getMetadataValue(metadata, 'Cover Letter Filename');

  if (manualResumeName || manualCoverName) {
    const rearPortion = getRearJobTitlePortion(metadata).replace(/\.pdf$/i, '').trim();
    if (rearPortion) {
      if (rearPortion.startsWith(applicantPrefix)) {
        return safeFilename(rearPortion);
      }
      return safeFilename(`${applicantPrefix}_${rearPortion}`);
    }
  }

  const jobId = getMetadataValue(metadata, 'Job ID');
  const company = getMetadataValue(metadata, 'Company');
  const jobTitle = getBestJobTitle(metadata);

  if (jobId && company) {
    return safeFilename(`${jobId} - ${company}`);
  }
  if (company && jobTitle) {
    return safeFilename(`${company} - ${jobTitle}`);
  }
  if (jobId) {
    return safeFilename(jobId);
  }
  if (company) {
    return safeFilename(company);
  }
  return safeFilename(`${applicantPrefix}_Job_Materials`);
}

/**
 * Searches for an active (non-trashed) subfolder by exact name inside parentFolder.
 */
function findFolderByExactNameInFolder(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  while (folders.hasNext()) {
    const folder = folders.next();
    if (!folder.isTrashed()) return folder;
  }
  return null;
}

/**
 * Retrieves an existing package subfolder or creates a new one within parentFolder.
 */
function getOrCreatePackageFolder(parentFolder, folderName) {
  if (REUSE_EXISTING_GENERATED_FILES) {
    const existing = findFolderByExactNameInFolder(parentFolder, folderName);
    if (existing) {
      vLog(`  - [RENDER ENGINE] Reusing existing package folder ID: ${existing.getId()} ("${folderName}")`);
      return existing;
    }
  }

  const newFolder = parentFolder.createFolder(folderName);
  vLog(`  - [RENDER ENGINE] Created new package folder ID: ${newFolder.getId()} ("${folderName}")`);
  return newFolder;
}

/**
 * Renders the application package artifacts (Tailored Resume PDF, Tailored Cover Letter PDF,
 * and LinkedIn posting URL KDE Plasma .desktop shortcut) into a dedicated package subfolder
 * within TARGET_FOLDER_ID_RENDER.
 */
function renderApplicationPackage(params) {
  const { targetRenderFolder, resumeFile, coverFile, metadata, jobUrl, config } = params;
  if (!targetRenderFolder) {
    vLog('[RENDER ENGINE] [WARNING] Target render folder is missing. Skipping package rendering.');
    return { packageFolder: null, resumePdfFile: null, coverPdfFile: null, desktopFile: null };
  }

  const packageFolderName = getRenderPackageFolderName(metadata, config);
  vLog(`[RENDER ENGINE] Resolving package subfolder "${packageFolderName}" in TARGET_FOLDER_ID_RENDER...`);
  const packageFolder = getOrCreatePackageFolder(targetRenderFolder, packageFolderName);

  vLog(`[RENDER ENGINE] Initiating rendering of application package into folder "${packageFolder.getName()}" (ID: ${packageFolder.getId()})...`);
  const rendered = {
    packageFolder: packageFolder,
    resumePdfFile: null,
    coverPdfFile: null,
    desktopFile: null
  };
  const errors = [];

  // 1. Tailored Resume -> PDF
  if (resumeFile) {
    try {
      const cleanResumeBaseName = safeFilename(resumeFile.getName()).replace(/\.pdf$/i, '');
      const resumePdfName = `${cleanResumeBaseName}.pdf`;
      vLog(`[RENDER ENGINE] Preparing Resume PDF: "${resumePdfName}"...`);

      let resumePdfFile = null;
      if (REUSE_EXISTING_GENERATED_FILES) {
        resumePdfFile = findFileByExactNameInFolder(packageFolder, resumePdfName);
        if (resumePdfFile) {
          vLog(`  - [RENDER ENGINE] Reusing existing rendered Resume PDF ID: ${resumePdfFile.getId()} ("${resumePdfName}")`);
        }
      }

      if (!resumePdfFile) {
        const resumeBlob = resumeFile.getAs(MimeType.PDF).setName(resumePdfName);
        resumePdfFile = packageFolder.createFile(resumeBlob);
        vLog(`  - [RENDER ENGINE] Rendered Resume PDF created successfully. File ID: ${resumePdfFile.getId()}`);
      }
      rendered.resumePdfFile = resumePdfFile;
    } catch (e) {
      const msg = `Resume PDF generation failed: ${e.message}`;
      vLog(`  - ❌ [RENDER ENGINE] [ERROR] ${msg}`);
      errors.push(msg);
    }
  } else {
    vLog('  - [RENDER ENGINE] [WARNING] Resume file not provided. Skipping Resume PDF rendering.');
  }

  // 2. Tailored Cover Letter -> PDF
  if (coverFile) {
    try {
      const cleanCoverBaseName = safeFilename(coverFile.getName()).replace(/\.pdf$/i, '');
      const coverPdfName = `${cleanCoverBaseName}.pdf`;
      vLog(`[RENDER ENGINE] Preparing Cover Letter PDF: "${coverPdfName}"...`);

      let coverPdfFile = null;
      if (REUSE_EXISTING_GENERATED_FILES) {
        coverPdfFile = findFileByExactNameInFolder(packageFolder, coverPdfName);
        if (coverPdfFile) {
          vLog(`  - [RENDER ENGINE] Reusing existing rendered Cover Letter PDF ID: ${coverPdfFile.getId()} ("${coverPdfName}")`);
        }
      }

      if (!coverPdfFile) {
        const coverBlob = coverFile.getAs(MimeType.PDF).setName(coverPdfName);
        coverPdfFile = packageFolder.createFile(coverBlob);
        vLog(`  - [RENDER ENGINE] Rendered Cover Letter PDF created successfully. File ID: ${coverPdfFile.getId()}`);
      }
      rendered.coverPdfFile = coverPdfFile;
    } catch (e) {
      const msg = `Cover Letter PDF generation failed: ${e.message}`;
      vLog(`  - ❌ [RENDER ENGINE] [ERROR] ${msg}`);
      errors.push(msg);
    }
  } else {
    vLog('  - [RENDER ENGINE] [WARNING] Cover Letter file not provided. Skipping Cover Letter PDF rendering.');
  }

  // 3. LinkedIn Posting URL -> KDE Plasma .desktop file
  if (jobUrl) {
    try {
      const linkedInBaseName = getLinkedInDocBaseName(metadata, config);
      const cleanDesktopBaseName = safeFilename(linkedInBaseName).replace(/\.desktop$/i, '');
      const desktopFileName = `${cleanDesktopBaseName}.desktop`;
      vLog(`[RENDER ENGINE] Preparing LinkedIn .desktop shortcut: "${desktopFileName}"...`);

      let desktopFile = null;
      if (REUSE_EXISTING_GENERATED_FILES) {
        desktopFile = findFileByExactNameInFolder(packageFolder, desktopFileName);
        if (desktopFile) {
          vLog(`  - [RENDER ENGINE] Reusing existing rendered LinkedIn .desktop file ID: ${desktopFile.getId()} ("${desktopFileName}")`);
        }
      }

      if (!desktopFile) {
        const humanReadableName = getHumanReadablePostingName(metadata);
        const resolvedUrl = sanitizeUrl(jobUrl) || String(jobUrl).trim();
        const desktopContent = [
          '[Desktop Entry]',
          'Type=Link',
          `Name=${humanReadableName}`,
          `URL=${resolvedUrl}`,
          'Icon=internet-web-browser',
          ''
        ].join('\n');

        const desktopBlob = Utilities.newBlob(desktopContent, MimeType.PLAIN_TEXT, desktopFileName);
        desktopFile = packageFolder.createFile(desktopBlob);
        vLog(`  - [RENDER ENGINE] Rendered LinkedIn .desktop file created successfully. File ID: ${desktopFile.getId()}`);
      }
      rendered.desktopFile = desktopFile;
    } catch (e) {
      const msg = `LinkedIn .desktop file generation failed: ${e.message}`;
      vLog(`  - ❌ [RENDER ENGINE] [ERROR] ${msg}`);
      errors.push(msg);
    }
  } else {
    vLog('  - [RENDER ENGINE] [WARNING] Job URL parameter missing. Skipping LinkedIn .desktop file rendering.');
  }

  if (errors.length > 0) {
    AppLogger.error('RENDER', `Encountered ${errors.length} error(s) during package rendering: ${errors.join('; ')}`);
    throw new Error(`Package rendering failed: ${errors.join('; ')}`);
  }

  return rendered;
}

function findFileByExactNameInFolder(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    const file = files.next();
    if (!file.isTrashed()) return file;
  }
  return null;
}

function removeStarLabels(body) {
  ['Situation: ', 'Task: ', 'Action: ', 'Result: '].forEach(label => replaceAllLiteralText(body, label, ''));
}

function normalizeResumeHeaderTop(doc) {
  [doc.getHeader(), doc.getBody()].filter(Boolean).forEach(container => {
    if (STRIP_LINKEDIN_FROM_RESUME_HEADER) {
      removeLinkedInFromTopContainer(container, 15);
    }
    cleanupTopHeaderSeparators(container, 15);
  });
}

function assertTemplatePlaceholdersResolved(doc, templateName) {
  if (!REQUIRE_TEMPLATE_PLACEHOLDER_COMPLETION) return;
  const unresolved = [];
  const placeholders = Object.values(TEMPLATE_PLACEHOLDERS);
  const containers = [doc.getHeader(), doc.getBody(), doc.getFooter()].filter(Boolean);

  containers.forEach(container => {
    placeholders.forEach(placeholder => {
      const found = container.findText(escapeRegex(placeholder));
      if (found && unresolved.indexOf(placeholder) === -1) unresolved.push(placeholder);
    });
  });

  if (unresolved.length > 0) {
    throw new Error(`Template placeholder(s) unresolved in ${templateName}: ${unresolved.join(', ')}`);
  }
}

function removeLinkedInFromTopContainer(container, maxChildren) {
  const limit = Math.min(container.getNumChildren(), maxChildren);
  for (let i = 0; i < limit; i++) {
    const child = container.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const text = child.editAsText();
      LINKEDIN_PATTERNS.forEach(pattern => {
        try { text.replaceText(pattern, ' '); } catch (e) {}
      });
    }
  }
}

function cleanupTopHeaderSeparators(container, maxChildren) {
  const limit = Math.min(container.getNumChildren(), maxChildren);
  for (let i = 0; i < limit; i++) {
    const child = container.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const text = child.editAsText();
      SEPARATOR_PATTERNS.forEach(p => {
        try { text.replaceText(p.search, p.replace); } catch (e) {}
      });
    }
  }
}

function shouldProcessSourceMaterialFile(file) {
  try {
    if (file.isTrashed && file.isTrashed()) return false;
  } catch (e) {}
  const name = String(file.getName() || '').toLowerCase();
  return /\.(md|markdown|txt)$/.test(name) || file.getMimeType() === MimeType.PLAIN_TEXT;
}

function getRequiredDeploymentConfig() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const configuredDocLogFolder = scriptProperties.getProperty(SCRIPT_PROPERTIES.DOC_LOG_FOLDER_ID) || DOC_LOG_FOLDER_ID;
  if (ENABLE_DOC_LOGGING && !configuredDocLogFolder) {
    throw new Error('DOC_LOG_FOLDER_ID must be configured when ENABLE_DOC_LOGGING is true.');
  }

  const config = {
    sourceFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.SOURCE_FOLDER_ID),
    targetFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.TARGET_FOLDER_ID),
    targetFolderIdRender: scriptProperties.getProperty(SCRIPT_PROPERTIES.TARGET_FOLDER_ID_RENDER),
    processedFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.PROCESSED_FOLDER_ID),
    failedFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.FAILED_FOLDER_ID),
    dupeFolderId: scriptProperties.getProperty(SCRIPT_PROPERTIES.DUPE_FOLDER_ID),
    resumeTemplateId: scriptProperties.getProperty(SCRIPT_PROPERTIES.RESUME_TEMPLATE_ID),
    coverTemplateId: scriptProperties.getProperty(SCRIPT_PROPERTIES.COVER_LETTER_TEMPLATE_ID),
    orApiKey: scriptProperties.getProperty(SCRIPT_PROPERTIES.OR_API_KEY),
    spreadsheetLogId: scriptProperties.getProperty(SCRIPT_PROPERTIES.SPREADSHEET_LOG_ID),
    applicantName: scriptProperties.getProperty(SCRIPT_PROPERTIES.APPLICANT_NAME),
    applicantEmail: scriptProperties.getProperty(SCRIPT_PROPERTIES.APPLICANT_EMAIL),
    docLogFolderId: configuredDocLogFolder
  };

  const requiredKeys = [
    'sourceFolderId', 'targetFolderId', 'processedFolderId', 'failedFolderId', 'dupeFolderId',
    'resumeTemplateId', 'coverTemplateId', 'orApiKey', 'applicantName'
  ];
  if (ENABLE_RENDER) requiredKeys.push('targetFolderIdRender');
  if (ENABLE_EMAIL_DISPATCH) requiredKeys.push('applicantEmail');
  if (ENABLE_SPREADSHEET_LOGGING) requiredKeys.push('spreadsheetLogId');

  const missing = requiredKeys.filter(key => !config[key]);
  if (missing.length > 0) throw new Error(`Missing Script Properties: ${missing.join(', ')}.`);
  return config;
}

/**
 * Main deployment orchestrator (Time-Chunked).
 */
function deployMaterials() {
  const startTime = Date.now();
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    vLog('[ORCHESTRATOR] [FATAL] Lock access execution failed. Another script run is locking process.');
    flushDocLogs();
    throw new Error('Could not acquire script lock.');
  }

  let config = null;
  try {
    vLog('[ORCHESTRATOR] Script lock claimed. Starting execution engine pass...');
    config = getRequiredDeploymentConfig();
    const sourceFolder = DriveApp.getFolderById(config.sourceFolderId);
    const targetFolder = DriveApp.getFolderById(config.targetFolderId);
    const targetRenderFolder = ENABLE_RENDER ? DriveApp.getFolderById(config.targetFolderIdRender) : null;
    const processedFolder = DriveApp.getFolderById(config.processedFolderId);
    const failedFolder = DriveApp.getFolderById(config.failedFolderId);
    const dupeFolder = DriveApp.getFolderById(config.dupeFolderId);
    const resumeTemplate = DriveApp.getFileById(config.resumeTemplateId);
    const coverTemplate = DriveApp.getFileById(config.coverTemplateId);
    const materialFiles = sourceFolder.getFiles();

    vLog(`[ORCHESTRATOR] Core folders identified. Render workflow: ${ENABLE_RENDER ? 'ENABLED' : 'DISABLED'}.`);

    try { preflightGmailDraftAuthorization(config); }
    catch (e) { vLog(`[ORCHESTRATOR] [WARNING] Gmail preflight check exception: ${e.message}`); }

    try { preflightSpreadsheetAuthorization(config); }
    catch (e) { vLog(`[ORCHESTRATOR] [WARNING] Spreadsheet preflight check exception: ${e.message}`); }

    scanForBounces(config);
    syncBouncedAddressesFromSheet(config);
    const processedJobIds = getProcessedJobIds(config);

    while (materialFiles.hasNext()) {
      if (Date.now() - startTime > SAFE_EXECUTION_LIMIT_MS) {
        vLog('[ORCHESTRATOR] ⏳ Execution window reached safe time limit (5 minutes). Halting file processing for this run.');
        RUN_METRICS.timeLimitReached = true;
        break;
      }

      const file = materialFiles.next();
      RUN_METRICS.filesDiscovered++;
      if (!shouldProcessSourceMaterialFile(file)) {
        vLog(`[ORCHESTRATOR] File: "${file.getName()}" does not match criteria. Skipping.`);
        RUN_METRICS.filesSkipped++;
        continue;
      }

      try {
        processSingleMaterialFile({
          file, targetFolder, targetRenderFolder, processedFolder, failedFolder, dupeFolder,
          resumeTemplate, coverTemplate, processedJobIds, config
        });
      } catch (e) {
        AppLogger.error('ORCHESTR', `Unexpected uncaught file-level failure for "${file.getName()}": ${e.message}`);
      }
      flushDocLogs(config && config.docLogFolderId);
    }
    vLog('[ORCHESTRATOR] Deployment loop finalized.');
  } catch (err) {
    vLog(`[ORCHESTRATOR] [FATAL] execution halted: ${err.message}`);
    throw err;
  } finally {
    outputExecutionSummary();
    flushDocLogs(config && config.docLogFolderId);
    lock.releaseLock();
    vLog('[ORCHESTRATOR] Release execution lock safely.');
  }
}

/**
 * Processes one source file through explicit, isolated pipeline stages.
 */
function processSingleMaterialFile(params) {
  const {
    file, targetFolder, targetRenderFolder, processedFolder, failedFolder, dupeFolder,
    resumeTemplate, coverTemplate, processedJobIds, config
  } = params;

  vLog('========================================================');
  vLog(`📥 Loading Material File: ${file.getName()} (ID: ${file.getId()})`);

  // --------------------------------------------------------------------------
  // Stage 1: INGEST & PARSE — terminal failure -> FAILED_FOLDER_ID
  // --------------------------------------------------------------------------
  let parsed;
  try {
    const fileContent = file.getBlob().getDataAsString();
    parsed = parseMarkdown(fileContent);
  } catch (e) {
    RUN_METRICS.filesFailed++;
    AppLogger.error('PARSER', `Ingest & Parse failed for "${file.getName()}": ${e.message}`);
    appendToSpreadsheetLog({
      status: LOG_STATUS_INGEST_PARSE_FAILED,
      company: '', jobId: '', jobTitle: file.getName(), targetEmail: '', emailTier: '', score: '',
      messageId: `ERROR: ${truncateText(e.message || 'Ingest/parse error', 150)}`, jobUrl: '',
      sourceFileName: file.getName()
    }, config);
    moveSourceFileSafely(file, failedFolder, 'FAILED_FOLDER_ID', 'INGEST & PARSE failure');
    return;
  }

  const metadata = parsed.metadata;
  const companyName = getMetadataValue(metadata, 'Company');
  const jobId = getMetadataValue(metadata, 'Job ID');
  const jobTitle = getBestJobTitle(metadata);
  const jobUrl = getMetadataValue(metadata, 'Job URL');
  vLog(`  - [CORE] Parsed Company Target: "${companyName}" | Resolved Job ID: "${jobId}"`);

  // --------------------------------------------------------------------------
  // Stage 2: DUPLICATE GATE — terminal diversion -> DUPE_FOLDER_ID
  // --------------------------------------------------------------------------
  if (jobId && processedJobIds.has(jobId)) {
    RUN_METRICS.filesSkipped++;
    RUN_METRICS.filesDuplicated++;
    vLog(`  - [CORE] Duplicate Job ID ${jobId} detected. Diverting source to DUPE_FOLDER_ID.`);
    appendToSpreadsheetLog({
      status: LOG_STATUS_DUPLICATE,
      company: companyName, jobId, jobTitle, targetEmail: '', emailTier: 'DUPLICATE', score: '',
      messageId: `SOURCE: ${file.getName()}`, jobUrl, sourceFileName: file.getName()
    }, config);
    moveSourceFileSafely(file, dupeFolder, 'DUPE_FOLDER_ID', 'duplicate material');
    return;
  }

  // --------------------------------------------------------------------------
  // Stage 3: GENERAL / DISCOVERY — nonterminal; DOCGEN must not depend on dispatchability
  // --------------------------------------------------------------------------
  let discoveryResult;
  try {
    discoveryResult = discoverApplicationEmailRoutes(metadata, config);
  } catch (e) {
    vLog(`  - [ROUTING] [WARNING] Unexpected discovery failure: ${e.message}. Continuing DOCGEN with no draftable routes.`);
    discoveryResult = buildFallbackDiscoveryResult(metadata, e);
  }

  // --------------------------------------------------------------------------
  // Stage 4: ADDRESS + DOCGEN — terminal failure -> FAILED_FOLDER_ID
  // --------------------------------------------------------------------------
  let newResumeFile = null;
  let coverDocResult = null;
  let linkedInFile = null;
  let companyAddress = '';
  try {
    companyAddress = discoveryResult.companyMailingAddress || getMetadataValue(metadata, 'Company Address');
    if (!companyAddress) {
      vLog('  - [CORE] Address value empty in discovery payload. Fetching standalone HQ address...');
      companyAddress = fetchCompanyAddress(companyName, metadata, config);
    }
    companyAddress = formatCorporateHQAddressBlock(metadata, companyAddress, companyName);
    metadata['Company Address'] = companyAddress;
    vLog(`  - [CORE] Finalized USPS Company Address: ${companyAddress || 'UNKNOWN'}`);

    newResumeFile = generateResumeDoc(resumeTemplate, targetFolder, metadata);
    coverDocResult = generateCoverLetterDoc(coverTemplate, targetFolder, metadata, parsed.content);
    if (jobUrl) linkedInFile = generateLinkedInDoc(targetFolder, metadata, jobUrl, config);
    else vLog('  - [DOCGEN] [WARNING] Job URL missing. Bypassing LinkedIn Doc generation.');
  } catch (e) {
    RUN_METRICS.filesFailed++;
    AppLogger.error('DOCGEN', `DOCGEN failed for Job ID ${jobId || 'UNKNOWN'}: ${e.message}`);
    appendToSpreadsheetLog({
      status: LOG_STATUS_DOCGEN_FAILED,
      company: companyName, jobId, jobTitle,
      targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
      emailTier: 'DOCGEN', score: discoveryResult && discoveryResult.score ? discoveryResult.score : '',
      messageId: `ERROR: ${truncateText(e.message || 'DOCGEN error', 150)}`, jobUrl,
      companyAddress, sourceFileName: file.getName()
    }, config);
    moveSourceFileSafely(file, failedFolder, 'FAILED_FOLDER_ID', 'DOCGEN failure');
    return;
  }

  // Core processing is complete at this point. Later failures cannot undo it.
  RUN_METRICS.filesProcessed++;
  if (jobId) processedJobIds.add(jobId);
  const plannedRecipients = getDispatchRecipientPlanForLogging(metadata, discoveryResult);
  appendToSpreadsheetLog({
    status: LOG_STATUS_CORE_PROCESSED,
    company: companyName, jobId, jobTitle,
    targetEmail: plannedRecipients.map(r => r.email).join(', '),
    emailTier: plannedRecipients.map(r => r.tier || '').join(', '),
    recipientScores: plannedRecipients.map(r => r.score || ''),
    score: discoveryResult.score || '', messageId: '', jobUrl,
    companyAddress, sourceFileName: file.getName()
  }, config);

  // --------------------------------------------------------------------------
  // Stage 5: OPTIONAL RENDER — independent nonterminal failure
  // --------------------------------------------------------------------------
  let renderedArtifacts = { packageFolder: null, resumePdfFile: null, coverPdfFile: null, desktopFile: null };
  if (ENABLE_RENDER) {
    try {
      renderedArtifacts = renderApplicationPackage({
        targetRenderFolder, resumeFile: newResumeFile, coverFile: coverDocResult.file,
        metadata, jobUrl, config
      });
      appendToSpreadsheetLog({
        status: LOG_STATUS_RENDER_COMPLETE, company: companyName, jobId, jobTitle,
        targetEmail: '', emailTier: '', score: discoveryResult.score || '', messageId: '', jobUrl
      }, config);
    } catch (e) {
      RUN_METRICS.renderFailures++;
      vLog(`  - [RENDER] [ERROR] Rendering failed independently: ${e.message}`);
      appendToSpreadsheetLog({
        status: LOG_STATUS_RENDER_FAILED,
        company: companyName, jobId, jobTitle,
        targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
        emailTier: 'RENDER', score: discoveryResult.score || '',
        messageId: `ERROR: ${truncateText(e.message || 'Render error', 150)}`, jobUrl
      }, config);
    }
  } else {
    appendToSpreadsheetLog({
      status: LOG_STATUS_RENDER_DISABLED, company: companyName, jobId, jobTitle,
      targetEmail: '', emailTier: '', score: discoveryResult.score || '', messageId: '', jobUrl
    }, config);
    vLog('  - [RENDER] Render workflow disabled by configuration. Skipping package rendering.');
  }

  // --------------------------------------------------------------------------
  // Stage 6: ANNOTATION — best effort only
  // --------------------------------------------------------------------------
  try {
    associateApplicationEmailDiscovery(metadata, discoveryResult);
    const filesToAnnotate = [newResumeFile, coverDocResult.file];
    if (linkedInFile) filesToAnnotate.push(linkedInFile);
    if (renderedArtifacts.resumePdfFile) filesToAnnotate.push(renderedArtifacts.resumePdfFile);
    if (renderedArtifacts.coverPdfFile) filesToAnnotate.push(renderedArtifacts.coverPdfFile);
    if (renderedArtifacts.desktopFile) filesToAnnotate.push(renderedArtifacts.desktopFile);
    if (renderedArtifacts.packageFolder) filesToAnnotate.push(renderedArtifacts.packageFolder);
    annotateGeneratedFilesWithApplicationEmail(filesToAnnotate, metadata, discoveryResult);
  } catch (e) {
    vLog(`  - [FILE META] [WARNING] Annotation failed independently: ${e.message}`);
  }

  // --------------------------------------------------------------------------
  // Stage 7: DISPATCH — fully independent from INGEST/PARSE/DOCGEN
  // --------------------------------------------------------------------------
  if (!ENABLE_EMAIL_DISPATCH || APPLICATION_DRAFT_MODE === 'OFF') {
    appendToSpreadsheetLog({
      status: LOG_STATUS_DISPATCH_DISABLED,
      company: companyName, jobId, jobTitle,
      targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
      emailTier: LOG_EMAIL_TIER_DISPATCH_DISABLED, score: discoveryResult.score || '',
      messageId: '', jobUrl
    }, config);
    vLog('  - [DISPATCH] Dispatch disabled; core material generation remains successful.');
  } else if (!discoveryResult.shouldCreateDraft) {
    RUN_METRICS.routesUnresolved++;
    appendToSpreadsheetLog({
      status: LOG_STATUS_NO_DRAFTABLE_ROUTE,
      company: companyName, jobId, jobTitle,
      targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
      emailTier: LOG_EMAIL_TIER_NO_DRAFTABLE_ROUTE, score: discoveryResult.score || '',
      messageId: '', jobUrl
    }, config);
    vLog('  - [DISPATCH] No draftable route found; DOCGEN remains successful.');
  } else {
    try {
      const dispatchResult = dispatchApplicationEmail(metadata, coverDocResult.text, newResumeFile, discoveryResult, config);
      const recipientResults = dispatchResult.recipientResults || [];
      if (recipientResults.length === 0) {
        RUN_METRICS.routesUnresolved++;
        appendToSpreadsheetLog({
          status: LOG_STATUS_NO_DRAFTABLE_ROUTE, company: companyName, jobId, jobTitle,
          targetEmail: '', emailTier: LOG_EMAIL_TIER_NO_DRAFTABLE_ROUTE, score: discoveryResult.score || '',
          messageId: '', jobUrl
        }, config);
        vLog('  - [DISPATCH] No usable recipients remained after final dispatch validation.');
      } else {
      const statusArray = recipientResults.map(r => r.status || LOG_STATUS_DISPATCH_FAILED);
      const emailArray = recipientResults.map(r => r.email || '');
      const tierArray = recipientResults.map(r => {
        const cand = asArray(discoveryResult.candidates).find(c => sanitizeEmailAddress(c.email) === sanitizeEmailAddress(r.email));
        if (r.status === LOG_STATUS_SUPPRESSED_BOUNCE) return LOG_EMAIL_TIER_SUPPRESSED_BOUNCE;
        if (r.status === LOG_STATUS_DISPATCH_FAILED) return LOG_EMAIL_TIER_DISPATCH_FAILED;
        return cand ? cand.tier : 'UNKNOWN';
      });
      const messageIdArray = recipientResults.map(r => sanitizeAlignedCsvField(r.messageId || (r.error ? `ERROR: ${truncateText(r.error, 120)}` : '')));
      const failedCount = recipientResults.filter(r => r.status === LOG_STATUS_DISPATCH_FAILED).length;
      if (failedCount > 0) RUN_METRICS.dispatchFailures += failedCount;

      const recipientScoreArray = recipientResults.map(r => {
        const cand = asArray(discoveryResult.candidates).find(c => sanitizeEmailAddress(c.email) === sanitizeEmailAddress(r.email));
        return cand && cand.score !== undefined ? cand.score : (discoveryResult.score || '');
      });
      appendToSpreadsheetLog({
        status: statusArray.join(', '), company: companyName, jobId, jobTitle,
        targetEmail: emailArray.join(', '), emailTier: tierArray.join(', '),
        recipientScores: recipientScoreArray,
        score: discoveryResult.score || '', messageId: messageIdArray.join(', '), jobUrl
      }, config);
      vLog(`  - [DISPATCH] Completed recipient-level dispatch: ${statusArray.join(', ') || 'NO TARGETS'}.`);
      }
    } catch (e) {
      RUN_METRICS.dispatchFailures++;
      appendToSpreadsheetLog({
        status: LOG_STATUS_DISPATCH_FAILED,
        company: companyName, jobId, jobTitle,
        targetEmail: getDispatchTargetEmailsForLogging(metadata, discoveryResult).join(', '),
        emailTier: LOG_EMAIL_TIER_DISPATCH_FAILED, score: discoveryResult.score || '',
        messageId: `ERROR: ${truncateText(e.message || 'Dispatch error', 150)}`, jobUrl
      }, config);
      vLog(`  - [DISPATCH] [ERROR] Dispatch failed independently: ${e.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Stage 8: FINALIZATION — DOCGEN success -> PROCESSED_FOLDER_ID
  // --------------------------------------------------------------------------
  if (MOVE_SOURCE_FILE_AFTER_SUCCESS) {
    moveSourceFileSafely(file, processedFolder, 'PROCESSED_FOLDER_ID', 'successful core processing');
  }
}

function buildFallbackDiscoveryResult(metadata, error) {
  return normalizeApplicationEmailDiscoveryResult({
    canonical_company: getMetadataValue(metadata, 'Canonical Company') || getMetadataValue(metadata, 'Company'),
    canonical_domain: getMetadataValue(metadata, 'Canonical Domain') || extractDomainFromUrl(getMetadataValue(metadata, 'Job URL')),
    entity_confidence: 0,
    primary_application_url: getMetadataValue(metadata, 'Primary Application URL') || getMetadataValue(metadata, 'Job URL'),
    ats_platform: getMetadataValue(metadata, 'ATS Platform') || detectAtsPlatform(getMetadataValue(metadata, 'Job URL')),
    all_candidates: [], suppressed_candidates: [],
    notes: `Discovery failed unexpectedly: ${error && error.message ? error.message : 'unknown error'}`
  }, metadata, 'fallback');
}

function moveSourceFileSafely(file, destinationFolder, destinationLabel, reason) {
  if (!file || !destinationFolder) {
    AppLogger.error('DRIVE', `Cannot move source for ${reason || 'unknown reason'}: destination ${destinationLabel || 'folder'} is unavailable.`);
    return false;
  }
  try {
    file.moveTo(destinationFolder);
    vLog(`  - [DRIVE] Source file moved to ${destinationLabel}: ${file.getName()} (${reason || 'no reason supplied'}).`);
    return true;
  } catch (e) {
    AppLogger.error('DRIVE', `Failed moving "${file.getName()}" to ${destinationLabel}: ${e.message}`);
    return false;
  }
}

function getDispatchRecipientPlanForLogging(metadata, discoveryResult) {
  const seen = new Set();
  const plan = [];
  asArray(discoveryResult && discoveryResult.candidates)
    .filter(c => c && c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT)
    .forEach(c => {
      const email = sanitizeEmailAddress(c.email);
      if (!email || seen.has(email)) return;
      seen.add(email);
      plan.push({ email, tier: c.tier || 'UNKNOWN', score: c.score !== undefined ? c.score : '' });
    });

  if (plan.length === 0) {
    const fallback = sanitizeEmailAddress(getMetadataValue(metadata, 'Application Email'));
    if (fallback) plan.push({ email: fallback, tier: 'MANUAL', score: discoveryResult && discoveryResult.score ? discoveryResult.score : '' });
  }
  return plan.slice(0, MAX_APPLICATION_RECIPIENT_SLOTS);
}

function getDispatchTargetEmailsForLogging(metadata, discoveryResult) {
  const candidateEmails = asArray(discoveryResult && discoveryResult.candidates)
    .filter(c => c && c.recommendedAction === DISCOVERY_ACTIONS.CREATE_DRAFT)
    .map(c => sanitizeEmailAddress(c.email))
    .filter(Boolean);

  if (candidateEmails.length > 0) return [...new Set(candidateEmails)];

  const fallback = sanitizeEmailAddress(getMetadataValue(metadata, 'Application Email'));
  return fallback ? [fallback] : [];
}

function getMetadataValue(metadata, key) {
  return metadata && metadata[key] ? String(metadata[key]).trim() : '';
}

function getNormalizedGmailAliases() {
  if (CACHED_GMAIL_ALIASES !== null) return CACHED_GMAIL_ALIASES;
  try {
    CACHED_GMAIL_ALIASES = GmailApp.getAliases().map(a => sanitizeEmailAddress(a)).filter(Boolean);
    return CACHED_GMAIL_ALIASES;
  } catch (e) {
    return [];
  }
}

function canUseGmailFromAddress(address) {
  const normalized = sanitizeEmailAddress(address);
  if (!normalized) return false;

  if (CACHED_EFFECTIVE_USER_EMAIL === null) {
    try {
      CACHED_EFFECTIVE_USER_EMAIL = sanitizeEmailAddress(Session.getEffectiveUser().getEmail());
    } catch (e) {
      CACHED_EFFECTIVE_USER_EMAIL = '';
    }
  }

  if (CACHED_EFFECTIVE_USER_EMAIL && normalized === CACHED_EFFECTIVE_USER_EMAIL) return true;

  const aliases = getNormalizedGmailAliases();
  return aliases.includes(normalized);
}

function getBestJobTitle(metadata) {
  return getMetadataValue(metadata, 'Job Title') || getMetadataValue(metadata, 'Role Title');
}

function asArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function sanitizeEmailAddress(value) {
  return String(value || '').trim().replace(/^mailto:/i, '').replace(/[<>()"'`,;\s]+/g, '').toLowerCase();
}

function isValidEmailAddress(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function getEmailLocalPart(email) {
  return String(email || '').split('@')[0].toLowerCase();
}

function sanitizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(null|none|n\/a|na|unknown)$/i.test(raw)) return '';

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) return '';
    return parsed.toString();
  } catch (e) {
    return '';
  }
}

function extractDomainFromUrl(value) {
  try {
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return normalizeDomain(new URL(url).hostname);
  } catch (e) { return ''; }
}

function normalizeDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function domainMatchesOrSubdomain(emailDomain, canonicalDomain) {
  return emailDomain && canonicalDomain && (emailDomain === canonicalDomain || emailDomain.endsWith(`.${canonicalDomain}`));
}

function domainLooksLikePublicEmailProvider(domain) {
  return['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'].includes(normalizeDomain(domain));
}

function oneLinePlainText(text) {
  return String(text || '').replace(/\r\n?/g, ' ').replace(/\s+/g, ' ').replace(/[<>]/g, '').trim();
}

function cleanLlmText(value) {
  const text = oneLinePlainText(value);
  return /^(null|none|n\/a|na|unknown)$/i.test(text) ? '' : text;
}

function truncateSubject(subject, maxLength) {
  return subject.length <= maxLength ? subject : subject.substring(0, maxLength - 3) + '...';
}

function truncateText(text, maxLength) {
  return text.length <= maxLength ? text : text.substring(0, maxLength - 3) + '...';
}

function appendSentence(existing, addition) {
  if (!addition) return existing;
  if (!existing) return addition;
  return /(?:\.|!|\?)$/.test(existing) ? `${existing} ${addition}` : `${existing}. ${addition}`;
}

function safeFilename(value) {
  return String(value || 'attachment').replace(/[\\/:*?"<>|]/g, '-').trim();
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAllLiteralText(body, literal, replacement) {
  let searchResult = body.findText(escapeRegex(literal));
  while (searchResult) {
    const el = searchResult.getElement().asText();
    const start = searchResult.getStartOffset();
    const end = searchResult.getEndOffsetInclusive();
    
    if (replacement !== '') {
      vLog(`[REPLACE ENGINE] Replacing bracket marker "${literal}" with replacement text...`);
      if (!replacement.includes('\n')) {
        // "Trojan Horse" insertion: Insert the new text *inside* the placeholder.
        // By inserting after the first character, we force Google Docs to inherit 
        // the exact formatting of the placeholder, completely bypassing hidden 
        // newline or paragraph styles that corrupt index 0 insertions.
        el.insertText(start + 1, replacement);
        el.deleteText(start, start);
        if (end > start) {
          el.deleteText(start + replacement.length, end + replacement.length - 1);
        }
      } else {
        // Multiline replacement: replace placeholder range directly to prevent paragraph split offset errors
        el.deleteText(start, end);
        el.insertText(start, replacement);
      }
    } else {
      vLog(`[REPLACE ENGINE] Cleaning empty placeholder key: "${literal}"`);
      el.deleteText(start, end);
    }
    
    searchResult = body.findText(escapeRegex(literal));
  }
}

function replaceFirstLiteralTextWithLinkEverywhere(doc, literal, replacement, url) {
  [doc.getHeader(), doc.getBody(), doc.getFooter()].filter(Boolean).forEach((container, containerIdx) => {
    const searchResult = container.findText(escapeRegex(literal));
    if (searchResult) {
      vLog(`[LINK ENGINE] Inserting link target inside layout zone #${containerIdx + 1}...`);
      const el = searchResult.getElement().asText();
      const start = searchResult.getStartOffset();
      const end = searchResult.getEndOffsetInclusive();
      
      if (replacement) {
        // "Trojan Horse" insertion to preserve formatting
        el.insertText(start + 1, replacement);
        el.deleteText(start, start);
        
        if (end > start) {
          el.deleteText(start + replacement.length, end + replacement.length - 1);
        }
        
        // Apply the hyperlink to the newly inserted text
        el.setLinkUrl(start, start + replacement.length - 1, url);
        vLog(`[LINK ENGINE] Hyperlink URL attached successfully: "${url}"`);
      } else {
        el.deleteText(start, end);
      }
    }
  });
}

function decodeCommonHtmlEntities(text) {
  return String(text || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTodaysDateString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'MMMM d, yyyy');
}

function getCurrentTimestampString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'yyyy-MM-dd HH:mm:ss');
}
