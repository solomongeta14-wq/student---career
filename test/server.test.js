const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const databasePath = path.join(os.tmpdir(), `firststep-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = databasePath;
delete require.cache[require.resolve('../server.js')];
const { createServer } = require('../server.js');

async function request(server, method, pathname, body, cookie, csrfToken) {
  const port = server.address().port;
  const headers = {
    Host: `127.0.0.1:${port}`,
    'Content-Type': 'application/json'
  };
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let result = {};
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text };
    }
  }
  return { response, result };
}

function extractSessionCookie(setCookieHeader) {
  return setCookieHeader ? String(setCookieHeader).split(';')[0] : '';
}

test('allows returning a submitted application status to the submitted state', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const graduateResult = await request(server, 'POST', '/api/auth/register', {
    name: 'Ada Student',
    email: `ada-${Date.now()}@example.com`,
    password: 'password123',
    role: 'graduate'
  });
  const graduateCookie = extractSessionCookie(graduateResult.response.headers.get('set-cookie'));
  assert.ok(graduateCookie, 'graduate registration should return a session cookie');

  const graduateSession = await request(server, 'GET', '/api/me', undefined, graduateCookie);
  assert.equal(graduateSession.result.user.role, 'graduate');
  const graduateCsrf = graduateSession.result.csrfToken;

  const employerResult = await request(server, 'POST', '/api/auth/register', {
    name: 'Hire Manager',
    email: `hire-${Date.now()}@example.com`,
    password: 'password123',
    role: 'employer',
    companyName: 'Demo Studio'
  });
  const employerCookie = extractSessionCookie(employerResult.response.headers.get('set-cookie'));
  const employerSession = await request(server, 'GET', '/api/me', undefined, employerCookie);
  const employerCsrf = employerSession.result.csrfToken;

  const jobResult = await request(server, 'POST', '/api/jobs', {
    title: 'Product Analyst',
    category: 'Business',
    location: 'Remote',
    type: 'Full-time',
    salary: '$70k',
    payPeriod: '/ year',
    description: 'Analyze product signals and help teams iterate with confidence.'
  }, employerCookie, employerCsrf);

  assert.equal(jobResult.response.status, 201, 'job creation should succeed for employer account');
  const jobId = jobResult.result.job.id;

  const applicationResult = await request(server, 'POST', `/api/jobs/${jobId}/applications`, {}, graduateCookie, graduateCsrf);
  assert.equal(applicationResult.response.status, 201, 'graduate should be able to apply to a role');
  const applicationId = applicationResult.result.applicationId;

  const statusResult = await request(server, 'PATCH', `/api/employer/applications/${applicationId}`, { status: 'submitted' }, employerCookie, employerCsrf);

  assert.equal(statusResult.response.status, 200, 'submitted application status should be accepted');
  assert.equal(statusResult.result.status, 'submitted');

  await new Promise(resolve => server.close(resolve));
});
