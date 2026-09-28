# Candidate profile template

Copy this directory to create your own profile, then replace every file.

```bash
# Linux / macOS
cp -r candidate_profile.example candidate_profile

# Windows (PowerShell)
Copy-Item -Recurse candidate_profile.example candidate_profile
```

Then point AstroOM at it:

```bash
astroom preflight --profile-dir ./candidate_profile --json
```

`preflight` fails until the two required files exist and are non-empty, so it is
the fastest way to confirm the profile is wired up before spending any tokens.

Every file here is placeholder text. Replace all of it: AstroOM sends this
content to whichever LLM provider your preset names, and the generated
application materials will otherwise describe the placeholder.

`candidate_profile/` is git-ignored. Keep your résumé and testimonials out of
version control and out of bug reports.

## A sharp edge: comment syntax

`search_terms.txt` ignores blank lines and anything starting with `#`, so the
comments in it are safe.

`company_filters.txt` and `title_filters.txt` are read **literally**: every line
becomes a case-insensitive substring that is excluded from the job set, and
`#` is not a comment marker there. Writing a `#` heading above your filters
would silently exclude every job whose description contains that text. That is
why both are shipped empty, with the guidance here instead. One filter per
line, no comments, no blank-line padding needed.

The other files (`my_resume.txt` and friends) are sent to the LLM as-is, so
`#` lines in them are read by the model as part of the text. That is fine for a
template you are about to replace wholesale, but not for a file you intend to
keep.
