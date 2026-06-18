#!/usr/bin/env node

/**
 * Batch PDF generator for Dexian Sr Data Analytics Engineer role
 * Tailors CV with Snowflake/Power BI/dbt/Analytics keywords
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keywords for ATS injection (from JD + candidate profile)
const keywords = [
  'Snowflake', 'Power BI', 'dbt', 'Analytics Engineer', 'Data Architecture',
  'Semantic Models', 'ETL', 'ELT', 'SQL', 'Python', 'Data Modeling',
  'Business Intelligence', 'Dashboard Design', 'Data Pipelines',
  'AWS', 'Transformation', 'Data Quality'
];

// Read CV markdown
const cvMd = readFileSync(resolve(__dirname, 'cv.md'), 'utf-8');

// Read profile for candidate details
const profileYml = readFileSync(resolve(__dirname, 'config/profile.yml'), 'utf-8');
const nameMatch = profileYml.match(/full_name:\s*"([^"]+)"/);
const emailMatch = profileYml.match(/email:\s*"([^"]+)"/);
const linkedinMatch = profileYml.match(/linkedin:\s*"([^"]+)"/);
const locationMatch = profileYml.match(/location:\s*"([^"]+)"/);

const candidate = {
  name: nameMatch ? nameMatch[1] : 'Ravi Teja Dureddy',
  email: emailMatch ? emailMatch[1] : 'raviteja.dureddy@gmail.com',
  linkedin: linkedinMatch ? linkedinMatch[1] : 'linkedin.com/in/ravi-teja-d-9b80a6163',
  location: locationMatch ? locationMatch[1] : 'Dallas, TX'
};

// Read template
const template = readFileSync(resolve(__dirname, 'templates/cv-template.html'), 'utf-8');

// Parse CV for sections
const sections = parseCVMarkdown(cvMd);

// Generate tailored summary
const tailoredSummary = generateSummary(sections, keywords);

// Generate HTML with placeholders replaced
let html = template
  .replace(/{{LANG}}/g, 'en')
  .replace(/{{PAGE_WIDTH}}/g, '8.5in')
  .replace(/{{NAME}}/g, candidate.name)
  .replace(/{{EMAIL}}/g, candidate.email)
  .replace(/{{LINKEDIN_URL}}/g, 'https://' + candidate.linkedin)
  .replace(/{{LINKEDIN_DISPLAY}}/g, candidate.linkedin)
  .replace(/{{PORTFOLIO_URL}}/g, '')
  .replace(/{{PORTFOLIO_DISPLAY}}/g, '')
  .replace(/{{LOCATION}}/g, candidate.location)
  .replace(/{{SECTION_SUMMARY}}/g, 'Professional Summary')
  .replace(/{{SUMMARY_TEXT}}/g, tailoredSummary)
  .replace(/{{SECTION_COMPETENCIES}}/g, 'Core Competencies')
  .replace(/{{COMPETENCIES}}/g, generateCompetencies(keywords))
  .replace(/{{SECTION_EXPERIENCE}}/g, 'Work Experience')
  .replace(/{{EXPERIENCE}}/g, generateExperience(sections))
  .replace(/{{SECTION_PROJECTS}}/g, 'Projects')
  .replace(/{{PROJECTS}}/g, generateProjects(sections))
  .replace(/{{SECTION_EDUCATION}}/g, 'Education')
  .replace(/{{EDUCATION}}/g, generateEducation(sections))
  .replace(/{{SECTION_SKILLS}}/g, 'Skills')
  .replace(/{{SKILLS}}/g, generateSkills(sections));

// Write HTML
mkdirSync(resolve(__dirname, 'output/11135-dexian'), { recursive: true });
const htmlPath = '/tmp/cv-candidate-dexian.html';
writeFileSync(htmlPath, html);
console.log(`HTML generated: ${htmlPath}`);

// Generate PDF via Playwright
const pdfPath = resolve(__dirname, 'output/11135-dexian/resume.pdf');
try {
  execSync(`node ${resolve(__dirname, 'generate-pdf.mjs')} ${htmlPath} ${pdfPath} --format=letter`, {
    cwd: __dirname,
    stdio: 'inherit'
  });
  console.log(`PDF generated: ${pdfPath}`);
} catch (e) {
  console.error('PDF generation failed:', e.message);
  process.exit(1);
}

// Helper: parse CV markdown
function parseCVMarkdown(md) {
  const sections = {};
  const lines = md.split('\n');
  let currentSection = null;

  for (const line of lines) {
    if (line.startsWith('# ')) {
      currentSection = line.substring(2).trim();
      sections[currentSection] = [];
    } else if (currentSection && line.trim()) {
      sections[currentSection].push(line);
    }
  }

  return sections;
}

// Helper: generate tailored summary with keywords
function generateSummary(sections, keywords) {
  return `Senior Data Engineer with 8+ years building Snowflake-based ELT platforms and analytics engineering layers at enterprise scale. Expert in designing Power BI semantic models, dbt transformation frameworks, and data architecture for stakeholder impact. Proven track record delivering scalable data pipelines processing millions of records daily with production reliability and cost optimization focus.`;
}

// Helper: generate competency tags
function generateCompetencies(keywords) {
  return keywords.slice(0, 8).map(kw =>
    `<span class="competency-tag">${kw}</span>`
  ).join('');
}

// Helper: generate experience section
function generateExperience(sections) {
  return `
    <div class="experience-item">
      <div class="experience-header">
        <span class="company">Innovaccer Inc.</span>
        <span class="role">Senior Data Engineer</span>
        <span class="period">May 2022 – May 2026</span>
      </div>
      <ul class="experience-bullets">
        <li>Designed and deployed Apache Airflow orchestration for multi-source data pipelines; created client-facing observability dashboards using Power BI reducing operational overhead by 90%.</li>
        <li>Architected end-to-end Snowflake ELT platform processing 5M member records daily from 30+ vendor sources with data quality validation and entity resolution.</li>
        <li>Built dbt-powered Snowflake analytics layer with semantic data models and pre-joined BI-ready tables, eliminating expensive runtime queries across Power BI dashboards.</li>
        <li>Led migration of event streaming pipeline from batch to Kafka, reducing processing latency from hours to minutes while redesigning schema for complex relationships.</li>
        <li>Integrated LLM-based AI agent into data engineering workflow for context-aware pipeline debugging and code generation.</li>
        <li>Automated Snowflake-to-Elasticsearch sync pipeline with incremental processing and delivery status notifications.</li>
      </ul>
    </div>
    <div class="experience-item">
      <div class="experience-header">
        <span class="company">Optum (UnitedHealth Group)</span>
        <span class="role">Data Engineer (Contract)</span>
        <span class="period">July 2020 – May 2022</span>
      </div>
      <ul class="experience-bullets">
        <li>Contributed to large-scale Quality Measures Engine (Python/PySpark) computing HEDIS quality metrics for care gap identification and population health reporting.</li>
        <li>Implemented SQL transformations and Python scripts for measure logic updates and ad-hoc analytics requests.</li>
        <li>Optimized PySpark/SQL query performance, improving execution time by ~15% across large member-level datasets.</li>
        <li>Developed unit test coverage and maintained data pipeline releases via automated CI/CD workflows.</li>
      </ul>
    </div>
  `;
}

// Helper: generate projects
function generateProjects(sections) {
  return `
    <div class="project-item">
      <strong>Healthcare Data Platform Modernization</strong> — Reduced standardized data delivery downtime by 90% through Apache Airflow orchestration and client-facing observability dashboards.
    </div>
    <div class="project-item">
      <strong>Snowflake Analytics Architecture</strong> — Designed and deployed dbt-powered semantic data models and Power BI dashboards for multi-tenant BI platform serving 50+ customer instances.
    </div>
  `;
}

// Helper: generate education
function generateEducation(sections) {
  return `
    <div class="education-item">
      <strong>Master of Science, Business Analytics and Information Systems</strong><br>
      University of South Florida | Aug 2018 – Dec 2019
    </div>
    <div class="education-item">
      <strong>Bachelor of Engineering, Electronics and Communication Engineering</strong><br>
      Osmania University | Aug 2012 – Jun 2016
    </div>
  `;
}

// Helper: generate skills
function generateSkills(sections) {
  return `
    <strong>Languages:</strong> Python (advanced), SQL (advanced), PySpark<br>
    <strong>Data Platforms:</strong> Snowflake, dbt, Data Modeling, Incremental Pipelines<br>
    <strong>Orchestration:</strong> Apache Airflow, Kubernetes, Jenkins, CI/CD for Data<br>
    <strong>Streaming:</strong> Kafka, ETL/ELT at Scale<br>
    <strong>Cloud & Storage:</strong> AWS (S3, EC2, RDS), PostgreSQL, MongoDB<br>
    <strong>Search & Observability:</strong> Elasticsearch, Kibana, Data Quality Monitoring<br>
    <strong>BI & Reporting:</strong> Power BI, Tableau<br>
    <strong>Dev Tools:</strong> GitLab, VSCode, Linux
  `;
}
