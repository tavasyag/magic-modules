# Adding `google_cloudbuild_gitlab_config` Resource

This document outlines the steps to implement the `google_cloudbuild_gitlab_config` resource
in magic-modules (tracking issue #26660).

The `BitbucketServerConfig` resource is the primary reference — GitLab config follows the
same pattern with different API endpoints and field names.

> **Note:** The GitLab V1 integration API is deprecated. This resource is still worth implementing
> for users who need to manage or migrate existing GitLab configs via Terraform.

---

## 1. Study the API

- API reference: `https://cloud.google.com/build/docs/api/reference/rest/v1/projects.locations.gitLabConfigs`
- Resource path: `projects/{project}/locations/{location}/gitLabConfigs/{id}`
- Operations: `create`, `get`, `patch`, `delete`, `list`, `removeGitLabConnectedRepository`

Go to the API reference and click into each method. Each method page shows the HTTP verb and
full URL. This is your source of truth for all URL fields, the update verb, and whether
async is needed.

### Fields

These come from the JSON representation and fields table on the API reference page.
For each field note: type, required/optional, output-only, and whether the description says
"cannot be changed" (immutable).

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Output only |
| `username` | string | Optional |
| `createTime` | string | Output only |
| `webhookKey` | string | Output only |
| `secrets.webhookSecretVersion` | string | Required, immutable |
| `secrets.apiKeyVersion` | string | Required, immutable |
| `secrets.apiAccessTokenVersion` | string | Required |
| `secrets.readAccessTokenVersion` | string | Required |
| `connectedRepositories[].id` | string | Format: `"namespace/project-slug"` |
| `connectedRepositories[].webhookId` | integer | Output only |
| `enterpriseConfig.hostUri` | string | Optional, immutable — GitLab Enterprise only |
| `enterpriseConfig.sslCa` | string | Optional — GitLab Enterprise only |
| `enterpriseConfig.serviceDirectoryConfig.service` | string | Optional |

---

## 2. Create the Resource YAML

**File:** `mmv1/products/cloudbuild/GitLabConfig.yaml`

Model after `mmv1/products/cloudbuild/BitbucketServerConfig.yaml`. The YAML is the core
definition MMv1 reads to auto-generate all Terraform Go code, schema, docs, and test
scaffolding. It has 5 sections:

---

### Section 1: Resource Metadata

```yaml
name: GitLabConfig
description: ...
references:
  guides:
    <page title>: <url>
  api: <api reference url>
```

**What it is:** The identity of the resource and links shown in generated docs.

**Where to find it:**
- `name` — matches the YAML filename without the extension
- `description` — from the top of the API reference page
- `guides` link — find the relevant how-to page in Google Cloud docs. The link text must
  match the exact page title. Verify the page exists before using it.
- `api` — the API reference URL for this resource

---

### Section 2: URL Configuration

```yaml
base_url: projects/{{project}}/locations/{{location}}/gitLabConfigs
self_link: projects/{{project}}/locations/{{location}}/gitLabConfigs/{{config_id}}
create_url: projects/{{project}}/locations/{{location}}/gitLabConfigs?gitlabConfigId={{config_id}}
update_mask: true
update_verb: PATCH
import_format:
  - projects/{{project}}/locations/{{location}}/gitLabConfigs/{{config_id}}
```

**What each field is:**

- `base_url` — used for list and create. The collection URL with no resource ID at the end.
  Found from the `create` or `list` method URL on the API reference.
- `self_link` — used for get and delete. The instance URL including the resource ID.
  Found from the `get` or `delete` method URL.
- `create_url` — only needed when create uses a different URL than `base_url`. Here the API
  requires the config ID as a query param (`?gitlabConfigId=`), which you see on the `create`
  method page. If create and list share the same URL, omit this field.
- `update_verb: PATCH` — the HTTP method shown on the `patch` method page.
- `update_mask: true` — the `patch` method page lists `updateMask` as a query parameter.
  If it's there, set this to true. If not, omit it.
- `import_format` — not from the API docs. Convention is to mirror `self_link` exactly.
  This is the string a user passes to `terraform import`.

MMv1 automatically prepends `https://cloudbuild.googleapis.com/v1/` — you only provide
the path portion.

---

### Section 3: Async / Operation Handling

```yaml
async:
  operation:
    base_url: '{{op_id}}'
  result:
    resource_inside_response: true
autogen_async: true
```

**What it is:** Some GCP APIs return a long-running Operation instead of the resource
immediately. MMv1 needs to know to poll until the operation completes.

**How you know it's needed:** On any method page (create, patch, delete), if the response
type is `Operation` rather than the resource itself, you need the async block. The `patch`
method page for this resource says "returns an Operation object" — that's your signal.

**Where the values come from:**
- `operation.base_url: '{{op_id}}'` — convention across all GCP async resources. The
  operation response includes a `name` field (the operation URL) which MMv1 captures as
  `{{op_id}}`. Always the same, copy from any async resource.
- `result.resource_inside_response: true` — means the final resource is nested inside
  the operation response. Copy from the reference resource (BitbucketServerConfig) and
  verify against the operation response schema in the API docs.
- `autogen_async: true` — always set unless you have unusual polling behavior. MMv1
  generates the polling logic automatically.
- `include_in_tgc_next: true` — not from the API. Marks the resource for inclusion in
  the next Terraform Google Cloud module release. Check with the team whether new resources
  should include this flag.

---

### Section 4: Custom Code Hooks

```yaml
custom_code:
  encoder: templates/terraform/encoders/cloudbuild_gitlab_config.go.tmpl
  post_create: templates/terraform/post_create/cloudbuild_gitlab_config.go.tmpl
  pre_update: templates/terraform/pre_update/cloudbuild_gitlab_config.go.tmpl
  post_update: templates/terraform/post_update/cloudbuild_gitlab_config.go.tmpl
```

**What it is:** Points to Go template files that inject custom logic at specific points in
the generated CRUD lifecycle. Only needed when the API has behavior MMv1 can't express in
YAML alone.

**How you know it's needed:** The API methods list includes `removeGitLabConnectedRepository`
— a dedicated endpoint just for removing repos. This means `connectedRepositories` cannot
be managed through a standard PATCH. The API requires separate calls to add and remove repos,
which the generated code has no way to handle. Four hook points are needed:

- `encoder` — fires before every create/update. Strips `connectedRepositories` from the
  request body so the main API call doesn't fail.
- `post_create` — fires after create succeeds. Calls `batchCreate` to attach repos now
  that the config exists.
- `pre_update` — fires before PATCH. Removes `connectedRepositories` from `updateMask`.
- `post_update` — fires after PATCH. Diffs old vs new repos, calls
  `removeGitLabConnectedRepository` for removed ones, calls `batchCreate` for new ones.

**Filenames:** Follow the naming convention of the reference resource with `gitlab` swapped in.

---

### Section 5: Samples

```yaml
samples:
  - name: cloudbuild_gitlab_config
    primary_resource_id: gitlab-config
    steps:
      - name: cloudbuild_gitlab_config
        resource_id_vars:
          config_id: gitlab-config
  - name: cloudbuild_gitlab_config_repositories
    primary_resource_id: gitlab-config-with-repos
    exclude_test: true
    ...
  - name: cloudbuild_gitlab_config_enterprise
    ...
```

**What it is:** Declares which `.tf.tmpl` sample files exist. Each sample serves two
purposes simultaneously — it becomes a usage example in the Terraform registry docs, and
it's used as a fixture for acceptance tests.

**Fields:**
- `name` — matches the `.tf.tmpl` filename in `mmv1/templates/terraform/examples/`
- `primary_resource_id` — the Terraform resource ID used inside the sample file
- `exclude_test: true` — sample is used for docs only, not run as an acceptance test.
  Use this when the test requires real credentials or setup that can't be automated.
- `steps` — the test steps to execute, usually one. References the sample by name.
- `resource_id_vars` — variable values passed into the template

**How you decide what samples to write:** One sample per distinct feature area of the
resource — basic usage, the complex field (`connectedRepositories`), and any optional
subsystem (`enterpriseConfig`). Cross-reference the Bitbucket samples for structure.

---

### Section 6: Parameters

```yaml
parameters:
  - name: config_id
    type: String
    required: true
    immutable: true
    url_param_only: true
    description: ...
  - name: location
    type: String
    required: true
    immutable: true
    url_param_only: true
    description: ...
```

**What it is:** URL-only inputs that are not API fields. They don't appear in the request
body — they only exist to construct the URL.

**How you find them:** Look at the URL structure:
```
projects/{{project}}/locations/{{location}}/gitLabConfigs/{{config_id}}
```
`{{project}}` is handled automatically by MMv1. Every other placeholder in the URL that
isn't a resource field becomes a parameter. If it appears in the URL but not in the API's
field schema, it's a parameter.

- `url_param_only: true` — tells MMv1 never to include this in the request body
- `immutable: true` — you can't change a resource's location or ID after creation

---

### Section 7: Properties

```yaml
properties:
  - name: name
    type: String
    output: true
    description: ...
  - name: secrets
    type: NestedObject
    required: true
    properties:
      - name: webhookSecretVersion
        ...
```

**What it is:** The actual API fields. These map directly to what you send in the request
body and what comes back in the response.

**Where to find them:** The JSON representation and fields table on the API reference page.
Every row in that table becomes a property. For nested objects, recurse down the schema.

**For each field determine:**
- `type` — String, Integer, Boolean, NestedObject, Array. Taken from the API field type.
- `required` — marked Required in the API docs
- `output: true` — marked Output only in the API docs. User can read it but not set it.
- `immutable: true` — API docs say "cannot be changed" or "Once this field has been set".
  Changing an immutable field forces destroy/recreate in Terraform.
- `is_set: true` — used on arrays where order doesn't matter and duplicates aren't allowed,
  like `connectedRepositories`

Each nested object in the API (`GitLabSecrets`, `GitLabRepositoryId`, `GitLabEnterpriseConfig`,
`ServiceDirectoryConfig`) becomes a `NestedObject` type with its own `properties` block.

---

## 3. Create Custom Code Templates

The `connectedRepositories` field cannot be set directly via PATCH — it requires separate
API calls, just like `BitbucketServerConfig`. Four templates are needed:

### `mmv1/templates/terraform/encoders/cloudbuild_gitlab_config.go.tmpl`

Strip `connectedRepositories` from the create/update body so it isn't sent on the main request.

Reference: `encoders/cloudbuild_bitbucketserver_config.go.tmpl`

### `mmv1/templates/terraform/post_create/cloudbuild_gitlab_config.go.tmpl`

After the config is created, call `connectedRepositories:batchCreate` if any repos were specified.

Reference: `post_create/cloudbuild_bitbucketserver_config.go.tmpl`

Key URL difference:
```
.../gitLabConfigs/{{config_id}}/connectedRepositories:batchCreate
```

### `mmv1/templates/terraform/pre_update/cloudbuild_gitlab_config.go.tmpl`

Remove `connectedRepositories` from the `updateMask` and reconstruct the PATCH URL.

Reference: `pre_update/cloudbuild_bitbucketserver_config.go.tmpl`

Key URL difference:
```
.../gitLabConfigs/{{config_id}}
```

### `mmv1/templates/terraform/post_update/cloudbuild_gitlab_config.go.tmpl`

Diff old vs new `connectedRepositories`, remove stale repos and batch-create new ones.

Reference: `post_update/cloudbuild_bitbucketserver_config.go.tmpl`

Key API differences vs Bitbucket:
- Remove: `POST .../gitLabConfigs/{id}:removeGitLabConnectedRepository`
  with body `{"connectedRepository": {...}}`
- Batch create: `POST .../gitLabConfigs/{id}/connectedRepositories:batchCreate`

---

## 4. Create Sample Templates

**Directory:** `mmv1/templates/terraform/examples/`

| File | Content | Test? |
|------|---------|-------|
| `cloudbuild_gitlab_config.tf.tmpl` | Basic config (gitlab.com, no repos) | Yes |
| `cloudbuild_gitlab_config_repositories.tf.tmpl` | With `connected_repositories` | No — needs real credentials |
| `cloudbuild_gitlab_config_enterprise.tf.tmpl` | With `enterprise_config`, `ssl_ca`, peered network | Yes |

Reference the corresponding Bitbucket samples for structure. The `samples` block in the YAML
references these files and controls which get turned into docs examples and tests.

---

## 5. Write Tests

Acceptance tests require real GitLab credentials. Per the issue, shared credentials will be
stored internally. Tests live either in:
- The `samples` block of the YAML (auto-generated), or
- `mmv1/third_party/terraform/services/cloudbuild/resource_cloudbuild_gitlab_config_test.go`

Test cases to cover:
1. Basic create, update, delete
2. Create with `connected_repositories`, then add/remove repos on update
3. GitLab Enterprise with `enterprise_config`, `ssl_ca`, and peered network

---

## 6. Verify Generation and Run Tests

Generate the provider output:

```bash
cd mmv1
go run . --output /path/to/terraform-provider-google --product products/cloudbuild
```

Run acceptance tests (requires credentials and `TF_ACC=1`):

```bash
cd /path/to/terraform-provider-google
TF_ACC=1 go test ./google/services/cloudbuild/... -run TestAccCloudbuildGitlabConfig -v -timeout 60m
```

---

## Reference Files

| Source (Bitbucket) | Target (GitLab) |
|--------------------|-----------------|
| `mmv1/products/cloudbuild/BitbucketServerConfig.yaml` | `mmv1/products/cloudbuild/GitLabConfig.yaml` |
| `encoders/cloudbuild_bitbucketserver_config.go.tmpl` | `encoders/cloudbuild_gitlab_config.go.tmpl` |
| `post_create/cloudbuild_bitbucketserver_config.go.tmpl` | `post_create/cloudbuild_gitlab_config.go.tmpl` |
| `pre_update/cloudbuild_bitbucketserver_config.go.tmpl` | `pre_update/cloudbuild_gitlab_config.go.tmpl` |
| `post_update/cloudbuild_bitbucketserver_config.go.tmpl` | `post_update/cloudbuild_gitlab_config.go.tmpl` |
| `samples/services/cloudbuild/cloudbuild_bitbucket_server_config*.tf.tmpl` | GitLab equivalents |
