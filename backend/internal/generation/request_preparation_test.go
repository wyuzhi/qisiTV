package generation

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/url"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestMultipartPreparationCannotBeAnUncertainPaidSubmission(t *testing.T) {
	_, _, err := ExecuteProtocolBinaryRequest(context.Background(), Config{}, protocol.RequestSpec{Method: "POST", Path: "/videos", ContentType: "multipart/form-data", Files: []protocol.RequestFilePart{{Name: "input_reference", Reference: protocol.MediaReference{DataURL: "data:image/png;base64,invalid"}}}})
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) {
		t.Fatalf("expected pre-dispatch preparation error: %v", err)
	}
	classified := ClassifyError(UncertainVideoSubmission(context.Background(), err))
	if classified.Uncertain || classified.Category == CategorySubmissionUncertain {
		t.Fatalf("unsent POST classified as paid uncertainty: %#v", classified)
	}
}

func TestManagedDiscoveryTransportFailureClassifiesAsRequestNotSent(t *testing.T) {
	for _, cause := range []error{
		io.EOF,
		&url.Error{Op: "Get", URL: "https://enterprise.beefapi.com/v1/models", Err: x509.UnknownAuthorityError{}},
		&net.DNSError{Err: "no such host", Name: "enterprise.beefapi.com"},
	} {
		err := wrapManagedDiscoveryError(cause)
		var preparation RequestPreparationError
		var notSent RequestNotSentError
		if !errors.As(err, &preparation) || !errors.As(err, &notSent) || !SafeRouteRejection(err) {
			t.Fatalf("expected unsent preparation error for %T: %#v", cause, err)
		}
		classified := ClassifyError(UncertainVideoSubmission(context.Background(), err))
		if classified.Uncertain || classified.Category != CategoryRequestNotSent || classified.BlocksAutomaticRetry() {
			t.Fatalf("discovery transport error %T misclassified: %#v", cause, classified)
		}
	}
}
