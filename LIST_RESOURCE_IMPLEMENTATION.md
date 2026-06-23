# List Resource Implementation Guide

List resources implement the Terraform 1.14+ `list` block, allowing users to query existing
resources without managing them:

```hcl
list "google_service_account" "all" {
  config {
    project = "my-project"
  }
}
```

The implementation is split into two phases: modifications to the **existing resource file**
(prerequisites), and creation of a **new `list_<resource_name>.go` file**.

Reference implementation: `mmv1/third_party/terraform/services/resourcemanager/list_google_service_account.go`

---

## Phase 1 — Prerequisites in the existing resource file

These changes must be made in `resource_<resource_name>.go` before the list file can work.

---

### Step 1 — Add `Identity` to the `schema.Resource`

**What:** Add an `Identity` field to the `schema.Resource` struct returned by `ResourceXxx()`,
defining which attributes uniquely identify one instance of this resource.

**Why:** The list machinery calls `listR.SDKv2Resource.Identity.SchemaMap()` to know which
fields form the identity. If `Identity` is nil, this panics at runtime. Identity also enables
Terraform 1.12+ structured `import {}` blocks as a bonus.

**How to find the right fields — concrete signals:**

1. **Look at `d.SetId(...)` in the create/read function.** Every variable substituted into the
   ID string is an identity field. The ID is the canonical unique address of the resource.

   ```go
   // google_service_account
   d.SetId(sa.Name)  // sa.Name = "projects/{project}/serviceAccounts/{email}"
   // → identity fields: project, email

   // google_dns_record_set
   d.SetId(fmt.Sprintf("projects/%s/managedZones/%s/rrsets/%s/%s", project, zone, name, rType))
   // → identity fields: project, managed_zone, name, type
   ```

2. **Look at the import function (`Importer.State`).** The regex named capture groups show
   exactly which fields are parsed and whether each is required or can be inferred.

   ```go
   tpgresource.ParseImportId([]string{
       "^projects/(?P<project>[^/]+)/serviceAccounts/(?P<email>[^/]+)$",
       "^(?P<email>[^/]+)$",  // project can be omitted → OptionalForImport
   }, d, config)
   ```

3. **For MMv1 resources:** check `identity:` in the resource's `.yaml` file. If absent,
   look at `import_format` — the `{{variables}}` in the format are the identity fields.

**`RequiredForImport` vs `OptionalForImport`:**
- `project`, `region`, `zone` — almost always `OptionalForImport` (provider has defaults)
- The resource's own unique key — always `RequiredForImport` (no default exists)
- Parent resource references (`managed_zone`, `instance`, etc.) — `RequiredForImport`

```go
Identity: &schema.ResourceIdentity{
    Version: 1,
    SchemaFunc: func() map[string]*schema.Schema {
        return map[string]*schema.Schema{
            "project": {Type: schema.TypeString, OptionalForImport: true},
            "email":   {Type: schema.TypeString, RequiredForImport: true},
        }
    },
},
```

---

### Step 2 — Add `MutableIdentity` (only when applicable)

**What:** Add `ResourceBehavior: schema.ResourceBehavior{MutableIdentity: true}` to the
`schema.Resource`.

**Why:** By default Terraform assumes identity is stable — once created, the identity fields
never change. `MutableIdentity: true` tells Terraform that identity fields can be updated
in-place without destroying and recreating the resource.

**Signal — look at each identity field in the resource schema:**

- If **all** identity fields have `ForceNew: true` (or are `Computed` derived from a `ForceNew`
  field) → **omit `MutableIdentity`**, identity is stable.
- If **any** identity field does NOT have `ForceNew: true` → **set `MutableIdentity: true`**,
  because that field can change on a live resource.

```
// google_dns_record_set
managed_zone → ForceNew: true   ✓
name         → ForceNew: true   ✓
type         → no ForceNew      ✗ → MutableIdentity: true

// google_service_account
account_id   → ForceNew: true   ✓
project      → ForceNew: true   ✓
email        → Computed only    ✓ (derived from account_id)
→ no MutableIdentity needed
```

---

### Step 3 — Call `SetResourceIdentityAttributes` in the read function

**What:** At the end of `resourceXxxRead`, call `tpgresource.SetResourceIdentityAttributes`
with the identity field values that were just read from the API.

**Why:** Terraform SDKv2 stores resource state and identity state separately. `d.Set("email", x)`
writes to resource state only. `SetResourceIdentityAttributes` writes the same values into the
parallel identity state. The list machinery calls `rd.TfTypeIdentityState()` to extract identity
from a `ResourceData` — if the identity state was never written, every list result has empty
identity, which defeats the purpose of a list resource.

**What to pass:** The exact same field names as defined in the `Identity.SchemaFunc` in Step 1,
with the values that were just fetched from the API.

```go
// At the end of resourceGoogleServiceAccountRead:
return tpgresource.SetResourceIdentityAttributes(d, map[string]interface{}{
    "email":   sa.Email,
    "project": sa.ProjectId,
})
```

---

### Step 4 — Extract a shared populate helper

**What:** Move the `d.Set(...)` calls from the read function into a standalone function
that both the read function and the list flattener (Step 10) can call. Include the
`SetResourceIdentityAttributes` call inside this helper.

**Why:** The list flattener needs to populate a `*schema.ResourceData` from an API response —
the exact same job as the read function. Without a shared helper, both places contain identical
field-setting logic that will drift out of sync as the resource evolves.

**What to extract vs what to leave in the read function:**

- **Extract:** All `d.Set(...)` calls that use data from a single API response object already
  in hand, plus `SetResourceIdentityAttributes`.
- **Leave:** Any code that requires an additional API call (e.g. billing account, IAM policy).
  The list flattener only has one item from the list response — it cannot make N+1 calls per item.

**Signal:** If a block in `resourceXxxRead` makes its own API call (has its own `SendRequest`,
`Retry`, typed client call, etc.), leave it in the read function. Everything else can move.

```go
// Extracted helper — called by both read and list flattener
func populateServiceAccountResourceData(d *schema.ResourceData, sa *iam.ServiceAccount, config *Config) error {
    d.Set("email", sa.Email)
    d.Set("project", sa.ProjectId)
    // ... all other fields ...
    return tpgresource.SetResourceIdentityAttributes(d, map[string]interface{}{
        "email":   sa.Email,
        "project": sa.ProjectId,
    })
}

// Read function becomes:
func resourceGoogleServiceAccountRead(d *schema.ResourceData, meta interface{}) error {
    // ... fetch sa from API ...
    return populateServiceAccountResourceData(d, sa, config)
}
```

---

## Phase 2 — Create `list_<resource_name>.go`

Create a new file in the same service package directory.

---

### Step 5 — Register in `init()`

**What:** Call `registry.FrameworkListResource{}.Register()` in a package-level `init()`.

**Why:** The provider discovers list resources through the registry at startup. Without
registration the list resource never gets surfaced to Terraform — it simply doesn't exist.
`init()` runs automatically when the package is imported (which happens via the blank import
in the test file).

```go
func init() {
    registry.FrameworkListResource{
        Name:        "google_service_account",  // exact resource type name
        ProductName: "resourcemanager",          // matches the product registration
        Func:        NewGoogleServiceAccountListResource,
    }.Register()
}
```

---

### Step 6 — Define the list model struct

**What:** A Go struct where each field corresponds to one entry in `ListConfigFields` (Step 7),
with a `tfsdk` tag matching the field name and a type matching the kind.

**Why:** `req.Config.Get(ctx, &data)` in `List()` deserializes the user's `config {}` block
into this struct using the `tfsdk` tags. Without it you cannot read the user's config values.

**Signal — one field per `ListConfigField`, types must match kinds:**

| `ListConfigKindXxx` | Go type        |
|---------------------|----------------|
| `ListConfigKindString` | `types.String` |
| `ListConfigKindBool`   | `types.Bool`   |
| `ListConfigKindInt64`  | `types.Int64`  |

```go
type GoogleServiceAccountListModel struct {
    Project types.String `tfsdk:"project"`
}
```

---

### Step 7 — Implement the constructor

**What:** `NewGoogleXxxListResource()` that creates the struct and sets `TypeName`,
`SDKv2Resource`, and `ListConfigFields` on the embedded `ListResourceMetadata`.

**Why:**
- `TypeName` — tells the framework which resource type this list resource serves
- `SDKv2Resource` — the existing `*schema.Resource` from Phase 1; provides the full resource
  schema (for `include_resource`) and the identity schema (for `SetResult`)
- `ListConfigFields` — defines the attributes available in the `config {}` block

**Signal for `ListConfigFields` — look at the list API URL:**

Ask: what parameters are needed to call the list endpoint?

- Parameters required to construct the URL (parent scope like `managed_zone`, `zone`) →
  `Optional: false` (Required)
- `project` when it scopes the list → `Optional: true` (defaults from provider)
- Optional query filter parameters (`name`, `type`, `filter`) → `Optional: true`
- If the resource IS the top-level entity (e.g. `google_project`) there may be no required
  scope field at all — only optional filters

```go
func NewGoogleServiceAccountListResource() list.ListResource {
    listR := &GoogleServiceAccountListResource{}
    listR.TypeName = "google_service_account"
    listR.SDKv2Resource = ResourceGoogleServiceAccount()
    listR.ListConfigFields = []tpgresource.ListConfigField{
        {Name: "project", Kind: tpgresource.ListConfigKindString, Optional: true},
    }
    return listR
}
```

---

### Step 8 — Override `Metadata()` (only when `MutableIdentity` applies)

**What:** Override the `Metadata` method to set `resp.ResourceBehavior.MutableIdentity = true`,
delegating to the base method first.

**Why:** The list resource must advertise the same identity mutability as the underlying
resource. If the resource has `MutableIdentity: true` (Step 2) but the list resource does not
declare it here, Terraform treats list results as having stable identity — incorrect behaviour
when identity fields can change.

**Signal:** Same as Step 2 — only add this override if you added `MutableIdentity: true` in
the resource file. Skip entirely otherwise.

```go
func (listR *GoogleDnsRecordSetResource) Metadata(ctx context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
    listR.ListResourceMetadata.Metadata(ctx, req, resp)
    resp.ResourceBehavior = resource.ResourceBehavior{MutableIdentity: true}
}
```

---

### Step 9 — Write the `ListXxx()` API function

**What:** A standalone exported function that builds the API URL, paginates through all pages,
and calls a callback with a populated `*schema.ResourceData` for each item.

**Why:** Kept separate from `List()` for testability (can be called directly without the
framework machinery) and potential reuse by sweepers or other callers.

**Two pagination approaches — signal for which to use:**

**Use `transport.ListPages()`** when:
- The API returns a standard REST envelope: a named array + `nextPageToken`
- You receive generic `map[string]interface{}` items (no typed Go client needed)
- Example: `google_service_account` — response has `{"accounts": [...], "nextPageToken": "..."}`

**Use manual pagination** when:
- A typed Go API client exists (e.g. `google.golang.org/api/dns/v1`) giving typed structs
- The response shape is non-standard or you need typed access for server-side filtering
- Example: `google_dns_record_set` — uses `googledns.ResourceRecordSetsListResponse`

**Signal for `ItemName` (when using `ListPages`):** The JSON key of the array in the response.
Check the data source for the same resource, or the API docs. Common values: `"items"` (default,
omit if this), `"accounts"`, `"projects"`, `"serviceAccounts"`.

**Building the URL:**
- For resources with a project/zone scope: use `tpgresource.ReplaceVars` with the resource's
  URL template (same as the read function)
- For top-level resources with no scope variable: build the URL directly using
  `fmt.Sprintf("https://cloudresourcemanager.%s/v1/projects", domain)` with
  `config.UniverseDomain` (defaulting to `"googleapis.com"` when empty)
- Do NOT use `transport_tpg.BaseUrl(product, config)` + `ReplaceVars` for top-level endpoints
  with no template variables — there is nothing to substitute and no applicable product base URL
- Always create a temporary `ResourceData` via `ResourceXxx().Data(&terraform.InstanceState{})`
  for `ReplaceVars` and `GenerateUserAgentString` — set any scope fields on it before use

**`BillingProject`:** Include when the API charges quota against a GCP project (most Compute,
GKE, etc. APIs). Omit when the endpoint bills against the caller's credentials directly
(e.g. Cloud Resource Manager project list).

```go
func ListServiceAccounts(config *transport_tpg.Config, project string, callback func(*schema.ResourceData) error) error {
    if config == nil {
        return fmt.Errorf("provider client is not configured")
    }
    d := ResourceGoogleServiceAccount().Data(&terraform.InstanceState{})
    if project != "" {
        d.Set("project", project)
    }
    url, err := tpgresource.ReplaceVars(d, config, transport_tpg.BaseUrl(iambeta.Product, config)+"projects/{{project}}/serviceAccounts")
    if err != nil {
        return err
    }
    userAgent, err := tpgresource.GenerateUserAgentString(d, config.UserAgent)
    if err != nil {
        return err
    }
    return transport_tpg.ListPages(transport_tpg.ListPagesOptions{
        Config:    config,
        TempData:  d,
        Resource:  ResourceGoogleServiceAccount(),
        ListURL:   url,
        ItemName:  "accounts",
        UserAgent: userAgent,
        Flattener: flattenGoogleServiceAccountListItem,
        Callback:  callback,
    })
}
```

---

### Step 10 — Write `flattenXxxListItem()`

**What:** A function that takes one API item and populates a `*schema.ResourceData`, including
calling `d.SetId(...)`.

**Why:** Bridges the API response format into the `ResourceData` format that `SetResult` reads.
`SetResult` needs a fully populated `ResourceData` — with both resource state and identity state
set — to produce a valid `list.ListResult`. The identity state is written by the shared
populate helper (Step 4) via its `SetResourceIdentityAttributes` call.

**Signature depends on pagination approach:**

- `transport.ListPages` requires: `func(item map[string]interface{}, d *schema.ResourceData, config *Config) error`
  — convert the map to a typed struct with `tpgresource.Convert`, then call the shared helper
- Manual pagination: you control the signature — take typed structs and call the shared helper directly

**`d.SetId(...)` format:** Use the exact same format as the main resource's `d.SetId` call in
create/read. This ensures the ID in list results matches what Terraform uses for state lookup.

**What NOT to do:** Do not make additional API calls inside the flattener. The flattener runs
once per item in the list response — any extra call would be N+1 requests.

```go
// Using transport.ListPages (generic map input)
func flattenGoogleServiceAccountListItem(res map[string]interface{}, d *schema.ResourceData, config *transport_tpg.Config) error {
    var sa iam.ServiceAccount
    if err := tpgresource.Convert(res, &sa); err != nil {
        return err
    }
    d.SetId(sa.Name)  // same format as resourceGoogleServiceAccountCreate
    return populateServiceAccountResourceData(d, &sa, config)  // shared helper from Step 4
}
```

---

### Step 11 — Implement `List()`

**What:** The framework entry point called for each user query. Decodes config, validates,
resolves scope fields, and sets `stream.Results` to a closure that calls `ListXxx()` and
pushes each result to the stream.

**Why:** This is what the framework calls. All the other pieces support this method.

**Four things always required:**

**1. Decode config first:**
```go
var data GoogleServiceAccountListModel
diags := listReq.Config.Get(ctx, &data)
if diags.HasError() {
    stream.Results = list.ListResultsStreamDiagnostics(diags)
    return
}
```

**2. Guard nil client before any API call:**
```go
if listR.Client == nil {
    diags = append(diags, diag.NewErrorDiagnostic("Provider not configured", "..."))
    stream.Results = list.ListResultsStreamDiagnostics(diags)
    return
}
```

**3. Resolve scope fields using the built-in helpers:**
- `listR.GetProject(data.Project)` — returns the config value if set, else provider default
- `listR.GetZone(data.Zone)`, `listR.GetRegion(data.Region)`, `listR.GetLocation(data.Location)`
- For optional filters with no provider fallback (e.g. `filter` string), use
  `data.Filter.ValueString()` directly — returns `""` when null/unknown, which is correct

**4. Handle stream closed — not an error:**
```go
errStreamClosed := errors.New("stream closed")
// in the callback:
if !push(result) {
    return errStreamClosed
}
// after ListXxx returns:
if errors.Is(err, errStreamClosed) {
    return  // consumer stopped early, not a failure
}
```

**Signal for display name keys in `SetResult`:** Pass the field name(s) that give the most
human-readable label for an instance of this resource. Look for `display_name`, `name`, or
`email` in the resource schema. Pass multiple for priority-ordered fallback. If no single field
is a clear human label, omit (pass no keys).

```go
// "display_name" tried first, falls back to "email" if empty
listR.SetResult(ctx, listReq.IncludeResource, &result, rd, "display_name", "email")
```

**Full example:**

```go
func (listR *GoogleServiceAccountListResource) List(ctx context.Context, listReq list.ListRequest, stream *list.ListResultsStream) {
    errStreamClosed := errors.New("stream closed")

    var data GoogleServiceAccountListModel
    diags := listReq.Config.Get(ctx, &data)
    if diags.HasError() {
        stream.Results = list.ListResultsStreamDiagnostics(diags)
        return
    }
    if listR.Client == nil {
        diags = append(diags, diag.NewErrorDiagnostic("Provider not configured", "..."))
        stream.Results = list.ListResultsStreamDiagnostics(diags)
        return
    }

    project := listR.GetProject(data.Project)

    stream.Results = func(push func(list.ListResult) bool) {
        err := ListServiceAccounts(listR.Client, project, func(rd *schema.ResourceData) error {
            result := listReq.NewListResult(ctx)
            if err := listR.SetResult(ctx, listReq.IncludeResource, &result, rd, "display_name", "email"); err != nil {
                return err
            }
            if !push(result) {
                return errStreamClosed
            }
            return nil
        })
        if err == nil || errors.Is(err, errStreamClosed) {
            return
        }
        diags.AddError("API Error", err.Error())
        result := listReq.NewListResult(ctx)
        result.Diagnostics = diags
        push(result)
    }
}
```

---

## Phase 3 — Testing

### Step 12 — Write the acceptance test

Create `list_<resource_name>_test.go` in the same package (with `_test` suffix).

**Test structure:**

- Use `acctest.VcrTest` with `resource.TestCase`
- Always gate on `tfversion.SkipBelow(tfversion.Version1_14_0)` — list resources require TF 1.14+
- Use `acctest.ProtoV5ProviderFactories` (not `ProviderFactories`)
- Blank-import the service package: `_ "github.com/.../google/services/<product>"`

**Step 1 — Do you need a setup step?**

**Signal:** Only add a non-query step before the query step if you need to **create** a resource
to guarantee it exists for the query to find.

- If the resource always pre-exists (e.g. `google_project` — the test project is always present),
  **skip step 1** entirely and start directly with the query step.
- If the resource may not exist (e.g. a service account with a random ID), **add step 1** to
  create it, then use the query step to verify it appears in results.

A data source lookup is NOT a valid step 1 — it doesn't create anything and adds no value.

**Query step config rules:**

- Always include `provider "google" {}` in the query step config — `provider = google` in the
  list block requires a declared provider.
- If there is a preceding non-query step that also declares `provider "google" {}`, the duplicate
  will cause a "Duplicate provider configuration" error — remove the provider block from the
  non-query step in that case.
- If the query step is the only step (no preceding step), include `provider "google" {}` in it.

**Assertions:**

- `querycheck.ExpectIdentity` — always include, checking every identity field
- `querycheck.ExpectLengthAtLeast(addr, 1)` — always include as a basic sanity check

```go
func TestAccServiceAccountListResource_queryIdentity(t *testing.T) {
    t.Parallel()

    accountId := "a" + acctest.RandString(t, 10)
    project := envvar.GetTestProjectFromEnv()
    expectedEmail := fmt.Sprintf("%s@%s.iam.gserviceaccount.com", accountId, project)

    acctest.VcrTest(t, resource.TestCase{
        TerraformVersionChecks: []tfversion.TerraformVersionCheck{
            tfversion.SkipBelow(tfversion.Version1_14_0),
        },
        PreCheck:                 func() { acctest.AccTestPreCheck(t) },
        ProtoV5ProviderFactories: acctest.ProtoV5ProviderFactories(t),
        Steps: []resource.TestStep{
            {
                // Step 1: create the resource so we know it exists
                Config: testAccServiceAccountBasic(accountId, "Terraform List Test", "list resource query test"),
            },
            {
                Query:  true,
                Config: testAccServiceAccountListQuery(project),
                QueryResultChecks: []querycheck.QueryResultCheck{
                    querycheck.ExpectIdentity("google_service_account.all_in_project", map[string]knownvalue.Check{
                        "email":   knownvalue.StringExact(expectedEmail),
                        "project": knownvalue.StringExact(project),
                    }),
                    querycheck.ExpectLengthAtLeast("google_service_account.all_in_project", 1),
                },
            },
        },
    })
}
```

**Running the test (from the downstream provider directory):**

```bash
VCR_PATH="$HOME/.vcr" VCR_MODE=RECORDING \
make testacc TEST=./google/services/<product>/... TESTARGS='-run=TestAccXxxListResource_queryIdentity$'
```

---

## Phase 4 — Documentation

### Step 13 — Create the list resource doc page

Create `mmv1/third_party/terraform/website/docs/list-resources/google_<resource>.html.markdown`.

**Structure** (follow this exactly — matches all existing list resource docs):

```markdown
---
subcategory: "<Product Category>"
description: |-
  List <resource description> for use with terraform query
  and .tfquery.hcl files.
---

# google_<resource> (list)

Lists <resource description> for use with
[`terraform query`](...) and **`.tfquery.hcl`** files. Results correspond to existing
[`google_<resource>`](...) managed resources.

For how list resources work in this provider, file layout, Terraform version requirements, and
shared `list` block arguments, refer to the guide
[Use list resources with terraform query (Google Cloud provider)](...).

## Example

```hcl
list "google_<resource>" "all" {
  provider = google

  config {
    # Comment describing each field
    # field = "value"
  }
}
```

Run `terraform query` from the directory that contains the `.tfquery.hcl` file.

## Configuration (`config` block)

* `field` - (Required/Optional) Description.

## Results

By default each result includes **resource identity** for `google_<resource>`:

* `identity_field` - Description (required for identity).

With `include_resource = true` on the `list` block, results also include the full resource-style
attributes documented for the managed [`google_<resource>` resource](...).
```

**`subcategory`** — must match the subcategory used in the resource's own `.html.markdown` doc.
Check `website/docs/r/google_<resource>.html.markdown` for the correct value.

---

## Quick reference — decision signals

| Decision | Signal / Tell |
|---|---|
| Identity fields | Variables in `d.SetId(...)` |
| `RequiredForImport` vs `OptionalForImport` | Has a provider-level default? Optional. No default? Required. |
| `MutableIdentity` | Any identity field missing `ForceNew: true`? Yes → set it. |
| `ListConfigFields` required vs optional | Required to construct the URL → Required. Query filter → Optional. |
| `ListPages` vs manual pagination | Typed Go API client available? Manual. Generic map response? `ListPages`. |
| `ItemName` in `ListPages` | JSON key of the array in the response body |
| `BillingProject` | API charges quota to a GCP project? Include it. Caller-level billing? Omit. |
| Display name keys in `SetResult` | Look for `display_name`, `name`, `email` in resource schema |
| What to extract into populate helper | Everything from one API object already in hand |
| What to leave in read function | Any block that makes its own additional API call |
| URL construction | Has template variables? Use `ReplaceVars`. No variables (top-level resource)? Use `fmt.Sprintf` with `config.UniverseDomain`. |
| Test: need setup step? | Resource might not exist → yes. Resource always pre-exists → no. |
| Test: `provider "google" {}` placement | Query-only test → in query config. Multi-step → only in query config, not in preceding step. |
| Doc subcategory | Match the subcategory in `website/docs/r/google_<resource>.html.markdown` |
