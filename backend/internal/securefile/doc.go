// Package securefile restricts a secret file to the current user: mode 0600 on
// Unix, and on Windows a DACL that no longer inherits the data directory's
// entries. Write the secret only after Protect and Verify succeed on the
// still-empty file.
package securefile
