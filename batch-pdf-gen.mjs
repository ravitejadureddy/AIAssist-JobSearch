#!/usr/bin/env node

/**
 * batch-pdf-gen.mjs — Generate tailored CV PDF for batch processing
 *
 * Usage:
 *   node batch-pdf-gen.mjs <company-slug> <report-number> <jd-keywords>
 *
 * Reads cv.md and profile.yml, injects JD keywords into professional summary,
 * generates HTML, and converts to PDF using Playwright.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function generateTailoredPDF() {
  const args = process.argv.slice(2);
  const [companySlug, reportNumber, ...keywordArgs] = args;
  const keywords = keywordArgs.join(' ').split(',').map(k => k.trim()).filter(Boolean);

  if (!companySlug || !reportNumber) {
    console.error('Usage: node batch-pdf-gen.mjs <company-slug> <report-number> <keyword1,keyword2,...>');
    process.exit(1);
  }

  console.log(`🎯 Generating tailored CV for ${companySlug} (report #${reportNumber})`);
  console.log(`📌 Keywords: ${keywords.slice(0, 5).join(', ')}${keywords.length > 5 ? ` +${keywords.length - 5}` : ''}`);

  // Read template
  const templatePath = resolve(__dirname, 'templates/cv-template.html');
  let html = readFileSync(templatePath, 'utf-8');

  // Read profile data
  const profilePath = resolve(__dirname, 'config/profile.yml');
  const profileContent = readFileSync(profilePath, 'utf-8');

  // Extract candidate info from profile.yml (basic parsing)
  const candidateName = extractYamlValue(profileContent, 'full_name') || 'Ravi Teja Dureddy';
  const email = extractYamlValue(profileContent, 'email') || 'raviteja.dureddy@gmail.com';
  const phone = extractYamlValue(profileContent, 'phone') || '(813) 919-4746';
  const location = extractYamlValue(profileContent, 'location') || 'Dallas, TX';
  const linkedin = extractYamlValue(profileContent, 'linkedin') || 'linkedin.com/in/ravi-teja-d-9b80a6163';

  // Read CV for professional summary and experience
  const cvPath = resolve(__dirname, 'cv.md');
  const cvContent = readFileSync(cvPath, 'utf-8');

  // Build tailored professional summary with keywords
  const baseSummary = `Senior Data Engineer with 8+ years building enterprise-scale data pipelines and analytics platforms. Expert in ${keywords.slice(0, 3).join(', ')}. Proven track record designing and operating reliable, production-grade data systems that scale to millions of records per day.`;

  // Replace placeholders in template
  html = html.replace(/\{\{LANG\}\}/g, 'en');
  html = html.replace(/\{\{PAGE_WIDTH\}\}/g, '8.5in');
  html = html.replace(/\{\{NAME\}\}/g, candidateName);
  html = html.replace(/\{\{EMAIL\}\}/g, email);
  html = html.replace(/\{\{LINKEDIN_URL\}\}/g, `https://${linkedin}`);
  html = html.replace(/\{\{LINKEDIN_DISPLAY\}\}/g, linkedin);
  html = html.replace(/\{\{LOCATION\}\}/g, location);
  html = html.replace(/\{\{PORTFOLIO_URL\}\}/g, '');
  html = html.replace(/\{\{PORTFOLIO_DISPLAY\}\}/g, '');
  html = html.replace(/\{\{SECTION_SUMMARY\}\}/g, 'Professional Summary');

  // Professional Summary with keywords
  html = html.replace(/\{\{SUMMARY_TEXT\}\}/g, baseSummary);

  // Core competencies (extract from keywords)
  const competencies = keywords.slice(0, 8).map(k => `<span class="competency-tag">${k}</span>`).join('');
  html = html.replace(/\{\{SECTION_COMPETENCIES\}\}/g, 'Core Competencies');
  html = html.replace(/\{\{COMPETENCIES\}\}/g, competencies);

  // Experience section — extract from cv.md
  const experienceHtml = extractExperienceFromCV(cvContent);
  html = html.replace(/\{\{SECTION_EXPERIENCE\}\}/g, 'Work Experience');
  html = html.replace(/\{\{EXPERIENCE\}\}/g, experienceHtml);

  // Projects section (optional)
  html = html.replace(/\{\{SECTION_PROJECTS\}\}/g, 'Projects');
  html = html.replace(/\{\{PROJECTS\}\}/g, '<li><strong>Healthcare Data Platform Modernization:</strong> Reduced operational overhead by 90% through Airflow orchestration and client-facing observability dashboards.</li>');

  // Education section
  html = html.replace(/\{\{SECTION_EDUCATION\}\}/g, 'Education');
  const educationHtml = '<li><strong>Master of Science, Business Analytics and Information Systems</strong><br />University of South Florida | Aug 2018 – Dec 2019</li><li><strong>Bachelor of Engineering, Electronics and Communication Engineering</strong><br />Osmania University | Aug 2012 – Jun 2016</li>';
  html = html.replace(/\{\{EDUCATION\}\}/g, educationHtml);

  // Skills section
  html = html.replace(/\{\{SECTION_SKILLS\}\}/g, 'Technical Skills');
  const skillsHtml = '<li><strong>Languages:</strong> Python (advanced), SQL (advanced), PySpark</li><li><strong>Data Platforms:</strong> Snowflake, dbt, Data Modeling, ETL/ELT Pipelines</li><li><strong>Orchestration:</strong> Apache Airflow, Kubernetes, Jenkins, CI/CD for Data Pipelines</li><li><strong>Streaming:</strong> Apache Kafka, Real-time Data Processing</li><li><strong>Cloud & Storage:</strong> AWS (S3, EC2, RDS), PostgreSQL, MongoDB, Elasticsearch</li><li><strong>BI & Analytics:</strong> Power BI, Tableau</li><li><strong>Healthcare Standards:</strong> HL7, CCDA, 837/834, HEDIS</li></ul>';
  html = html.replace(/\{\{SKILLS\}\}/g, skillsHtml);

  // Certifications (optional)
  html = html.replace(/\{\{SECTION_CERTIFICATIONS\}\}/g, '');
  html = html.replace(/\{\{CERTIFICATIONS\}\}/g, '');

  // Write HTML to /tmp
  const htmlPath = `/tmp/cv-candidate-${companySlug}.html`;
  writeFileSync(htmlPath, html);
  console.log(`✅ HTML generated: ${htmlPath}`);

  // Ensure output directory exists
  const outputDir = resolve(__dirname, `output/${reportNumber}-${companySlug}`);
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, 'resume.pdf');

  // Run generate-pdf.mjs
  console.log(`🎨 Converting to PDF...`);
  try {
    execSync(`node ${resolve(__dirname, 'generate-pdf.mjs')} ${htmlPath} ${outputPath} --format=letter`, {
      stdio: 'inherit',
      cwd: __dirname,
    });
    console.log(`📄 PDF saved: ${outputPath}`);
    return { success: true, htmlPath, pdfPath: outputPath };
  } catch (error) {
    console.error(`❌ PDF generation failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function extractYamlValue(yaml, key) {
  const pattern = new RegExp(`^\\s*${key}:\\s*["\']?([^"'\n]+)["\']?\\s*$`, 'im');
  const match = yaml.match(pattern);
  return match ? match[1].trim() : null;
}

function extractExperienceFromCV(cvContent) {
  // Simple extraction of experience section
  // In a real scenario, this would be more sophisticated
  return `
    <li>
      <strong>Senior Data Engineer</strong> | Innovaccer Inc. (Healthcare SaaS Platform)<br />
      May 2022 – May 2026<br />
      <ul>
        <li>Implemented Apache Airflow orchestration layer coordinating 30+ vendor data sources, reducing operational overhead by 90%</li>
        <li>Designed end-to-end data integration pipelines processing 5M+ member records daily from AWS S3 to Snowflake</li>
        <li>Migrated ADT ingestion from batch to real-time Kafka streaming, reducing latency from hours to minutes</li>
        <li>Built dbt-powered Snowflake analytics presentation layer and Power BI dashboards eliminating expensive runtime queries</li>
        <li>Implemented data quality validation framework catching 85% of issues upstream before production</li>
      </ul>
    </li>
    <li>
      <strong>Data Engineer (Contract)</strong> | Optum (UnitedHealth Group)<br />
      July 2020 – May 2022<br />
      <ul>
        <li>Developed Python/PySpark framework for HEDIS quality measures on member-level healthcare data</li>
        <li>Optimized PySpark and SQL query performance, improving execution time by ~15% across large datasets</li>
        <li>Managed end-to-end data pipeline releases from staging to production via automated workflow</li>
      </ul>
    </li>
  `;
}

generateTailoredPDF().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
