#!/usr/bin/env node
/**
 * Quick PDF generator for batch processing
 * Personalizes CV for specific JD and generates PDF
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, resolve } from 'path';

const reportNum = '11090';
const company = 'akraya';
const date = '2026-06-17';

// JD keywords for personalization
const jdKeywords = {
  "SQL": true,
  "Python": true,
  "Data Warehousing": true,
  "ETL/ELT": true,
  "Data Modeling": true,
  "Snowflake": true,
  "Apache Airflow": true,
  "Hierarchical Data Model": true,
  "Schema Optimization": true,
  "Data Pipelines": true,
  "Data Quality": true,
  "Data Integration": true,
  "AWS": true
};

// Read template
const template = readFileSync('/Users/ravidureddy/Desktop/career-ops/templates/cv-template.html', 'utf8');

// Create personalized summary with keywords
const summaryText = `Senior Data Engineer with 8+ years designing and optimizing enterprise data warehouses and ETL/ELT pipelines at scale. Expert in SQL, Python, data modeling, and schema optimization using Snowflake and Apache Airflow. Proven track record re-architecting hierarchical data models into production-ready warehouse schemas supporting 5M+ records/day. Skilled in data quality validation, automated pipeline orchestration, and cross-functional collaboration to deliver reliable, high-performance analytical systems.`;

// Core competencies (6-8 tags)
const competencies = `
  <span class="competency-tag">SQL</span>
  <span class="competency-tag">Python</span>
  <span class="competency-tag">Data Warehousing</span>
  <span class="competency-tag">ETL/ELT Pipelines</span>
  <span class="competency-tag">Snowflake</span>
  <span class="competency-tag">Data Modeling</span>
  <span class="competency-tag">Apache Airflow</span>
  <span class="competency-tag">Schema Optimization</span>
`;

// Work experience (prioritize Innovaccer, then Optum)
const experience = `
  <div class="job">
    <div class="job-header">
      <span class="job-company">Innovaccer Inc.</span>
      <span class="job-period">May 2022 – May 2026</span>
    </div>
    <div class="job-role">Senior Data Engineer</div>
    <ul>
      <li>Designed and optimized end-to-end data integration pipelines processing 5M+ member records per customer daily — ingesting multi-source vendor data into Snowflake, running through standardization and transformation layers, and consolidating into unified entity schema across 30+ vendor sources.</li>
      <li>Built Snowflake analytics presentation layer using dbt, eliminating expensive runtime queries and reducing BI dashboard refresh time by 60% through optimized schema design and incremental transformation pipelines.</li>
      <li>Architected Apache Airflow orchestration layer to coordinate pipeline operations — detecting vendor file arrivals on S3, monitoring ETL workflow completion, and alerting team on failures. Reduced manual operational overhead by 90%.</li>
      <li>Implemented data quality validation framework with Great Expectations, catching 100% of data integrity issues within 1 hour and reducing downstream errors by zero-defect tracking over 12+ months.</li>
      <li>Migrated ADT (admission/discharge/transfer) event ingestion from batch to streaming using Kafka, reducing event processing latency from 24 hours to &lt;5 minutes while designing schema to handle new relationship types via extension tables.</li>
      <li>Automated Snowflake-to-Elasticsearch sync pipeline with incremental delivery, replacing manual processes and ensuring real-time data freshness across client applications.</li>
      <li>Mentored junior data engineers and partnered with product and client teams to translate data requirements into scalable engineering solutions.</li>
    </ul>
  </div>

  <div class="job">
    <div class="job-header">
      <span class="job-company">Optum</span>
      <span class="job-period">July 2020 – May 2022</span>
    </div>
    <div class="job-role">Data Engineer (Contract)</div>
    <ul>
      <li>Worked within Quality Measures Engine framework — Python and PySpark system ingesting member-level healthcare data and computing HEDIS and custom quality measures for population health reporting and care gap identification.</li>
      <li>Implemented data quality testing and validation framework, improving reliability and reducing regression risk across releases; optimized PySpark and SQL query performance by ~15% across large member-level datasets.</li>
      <li>Managed end-to-end data pipeline releases from feature branches through staging to production via automated release workflow, ensuring consistent and validated deployments.</li>
      <li>Built Python-based release tracking tool providing real-time visibility into pipeline execution stages, reducing manual tracking overhead.</li>
    </ul>
  </div>

  <div class="job">
    <div class="job-header">
      <span class="job-company">Deloitte Consulting</span>
      <span class="job-period">March 2020 – July 2020</span>
    </div>
    <div class="job-role">Data Science Analyst</div>
    <ul>
      <li>Improved data collection efficiency by 40% through workflow analysis, SQL optimization, and streamlined business reporting.</li>
      <li>Analyzed government client datasets using SQL and reporting tools to surface patterns and trends, delivering stakeholder-facing reports and dashboards.</li>
    </ul>
  </div>

  <div class="job">
    <div class="job-header">
      <span class="job-company">Accenture</span>
      <span class="job-period">Aug 2016 – July 2018</span>
    </div>
    <div class="job-role">Application Development Analyst</div>
    <ul>
      <li>Executed daily, weekly, and monthly software releases using release management tooling and Python automation scripts.</li>
      <li>Developed Python and PowerShell automation to streamline deployment and configuration tasks, reducing manual effort in release cycles.</li>
    </ul>
  </div>
`;

// Projects (3-4 most relevant)
const projects = `
  <div class="project">
    <div>
      <span class="project-title">Healthcare Data Warehouse Modernization</span>
      <span class="project-badge">Innovaccer</span>
    </div>
    <div class="project-desc">Re-engineered multi-source healthcare data ingestion into unified Snowflake warehouse serving 30+ vendor sources and 5M+ daily member records. Designed schema optimization for analytics performance and built dbt-powered presentation layer eliminating expensive runtime queries.</div>
    <div class="project-tech">Snowflake · dbt · Python · Apache Airflow · Data Modeling · Schema Optimization</div>
  </div>

  <div class="project">
    <div>
      <span class="project-title">Real-Time Event Streaming Migration</span>
      <span class="project-badge">Innovaccer</span>
    </div>
    <div class="project-desc">Migrated ADT event ingestion from daily batch processing to Kafka-based streaming pipeline. Redesigned schema to support new relationship types via extension tables, reducing event latency from 24 hours to &lt;5 minutes.</div>
    <div class="project-tech">Kafka · Snowflake · Python · Event Streaming · Schema Design</div>
  </div>

  <div class="project">
    <div>
      <span class="project-title">Data Quality & Observability Framework</span>
      <span class="project-badge">Innovaccer</span>
    </div>
    <div class="project-desc">Built comprehensive data validation and observability system using Great Expectations and Apache Airflow. Automated quality checks for healthcare data (HEDIS logic, claim thresholds) with Slack alerting. Achieved zero downstream data quality errors over 12+ months.</div>
    <div class="project-tech">Great Expectations · Apache Airflow · Python · Data Quality · Alerting</div>
  </div>
`;

// Education
const education = `
  <div class="edu-item">
    <div class="edu-header">
      <div>
        <div class="edu-title">Master of Science, <span class="edu-org">Business Analytics and Information Systems</span></div>
        <div class="edu-desc">University of South Florida</div>
      </div>
      <div class="edu-year">Aug 2018 – Dec 2019</div>
    </div>
  </div>
  <div class="edu-item">
    <div class="edu-header">
      <div>
        <div class="edu-title">Bachelor of Engineering, <span class="edu-org">Electronics and Communication Engineering</span></div>
        <div class="edu-desc">Osmania University</div>
      </div>
      <div class="edu-year">Aug 2012 – Jun 2016</div>
    </div>
  </div>
`;

// Certifications (if any)
const certifications = `<!-- No certifications listed -->`;

// Skills
const skills = `
  <div class="skill-item">
    <span class="skill-category">Languages:</span> Python (advanced), SQL (advanced), PySpark
  </div>
  <div class="skill-item">
    <span class="skill-category">Data Warehousing & Modeling:</span> Snowflake, dbt, Data Modeling, Incremental Pipelines, Schema Optimization
  </div>
  <div class="skill-item">
    <span class="skill-category">Orchestration & Ops:</span> Apache Airflow, Kubernetes, Jenkins, Workflow Scheduling, Alerting & Monitoring
  </div>
  <div class="skill-item">
    <span class="skill-category">Streaming & Integration:</span> Apache Kafka, ETL/ELT, Real-Time Processing, Data Integration
  </div>
  <div class="skill-item">
    <span class="skill-category">Cloud & Storage:</span> AWS (S3, EC2, RDS), PostgreSQL, MongoDB, Elasticsearch
  </div>
  <div class="skill-item">
    <span class="skill-category">Observability & Quality:</span> Kibana, Data Quality Monitoring, Ingestion Completeness, Great Expectations
  </div>
  <div class="skill-item">
    <span class="skill-category">BI & Analytics:</span> Power BI, Tableau
  </div>
  <div class="skill-item">
    <span class="skill-category">Development Tools:</span> GitLab, VSCode, Linux
  </div>
`;

// Replace placeholders
let html = template
  .replace(/\{\{LANG\}\}/g, 'en')
  .replace(/\{\{PAGE_WIDTH\}\}/g, '8.5in')
  .replace(/\{\{NAME\}\}/g, 'RAVI TEJA DUREDDY')
  .replace(/\{\{PHONE\}\}/g, '(813) 919-4746')
  .replace(/\{\{EMAIL\}\}/g, 'raviteja.dureddy@gmail.com')
  .replace(/\{\{LINKEDIN_URL\}\}/g, 'https://www.linkedin.com/in/ravi-teja-d-9b80a6163/')
  .replace(/\{\{LINKEDIN_DISPLAY\}\}/g, 'LinkedIn')
  .replace(/\{\{PORTFOLIO_URL\}\}/g, '')
  .replace(/\{\{PORTFOLIO_DISPLAY\}\}/g, '')
  .replace(/\{\{LOCATION\}\}/g, 'Dallas, TX')
  .replace(/\{\{SECTION_SUMMARY\}\}/g, 'Professional Summary')
  .replace(/\{\{SUMMARY_TEXT\}\}/g, summaryText)
  .replace(/\{\{SECTION_COMPETENCIES\}\}/g, 'Core Competencies')
  .replace(/\{\{COMPETENCIES\}\}/g, competencies)
  .replace(/\{\{SECTION_EXPERIENCE\}\}/g, 'Work Experience')
  .replace(/\{\{EXPERIENCE\}\}/g, experience)
  .replace(/\{\{SECTION_PROJECTS\}\}/g, 'Projects')
  .replace(/\{\{PROJECTS\}\}/g, projects)
  .replace(/\{\{SECTION_EDUCATION\}\}/g, 'Education')
  .replace(/\{\{EDUCATION\}\}/g, education)
  .replace(/\{\{SECTION_CERTIFICATIONS\}\}/g, 'Certifications')
  .replace(/\{\{CERTIFICATIONS\}\}/g, certifications)
  .replace(/\{\{SECTION_SKILLS\}\}/g, 'Skills')
  .replace(/\{\{SKILLS\}\}/g, skills);

// Remove portfolio contact row if empty
html = html.replace(/<a href="">[^<]*<\/a>\s*<span class="separator">\|<\/span>\s*/g, '');

// Write HTML to /tmp
writeFileSync('/tmp/cv-candidate-akraya.html', html, 'utf8');
console.log('✓ Generated /tmp/cv-candidate-akraya.html');

// Create output directory
mkdirSync(`/Users/ravidureddy/Desktop/career-ops/output/${reportNum}-${company}`, { recursive: true });

// Generate PDF using generate-pdf.mjs
try {
  console.log('⏳ Rendering PDF with Chromium...');
  execSync(`node /Users/ravidureddy/Desktop/career-ops/generate-pdf.mjs /tmp/cv-candidate-akraya.html /Users/ravidureddy/Desktop/career-ops/output/${reportNum}-${company}/resume.pdf --format=letter`, {
    cwd: '/Users/ravidureddy/Desktop/career-ops',
    stdio: 'inherit'
  });
  console.log(`✓ PDF saved to output/${reportNum}-${company}/resume.pdf`);
} catch (error) {
  console.error('❌ PDF generation failed:', error.message);
  process.exit(1);
}
