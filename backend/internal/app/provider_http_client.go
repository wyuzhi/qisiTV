package app

import (
	"context"
	"mime/multipart"
	"net/http"
	"time"

	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
)

func withHTTPRequestRuntime(req *http.Request) *http.Request {
	if req == nil {
		return req
	}
	return req.WithContext(bindRequestReceipts(req.Context()))
}

func postGeminiJSON(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	return generation.PostGeminiJSON(bindRequestReceipts(ctx), config, path, body, target)
}

func getGeminiJSON(ctx context.Context, config providerConfig, path string, target interface{}) error {
	return generation.GetGeminiJSON(bindRequestReceipts(ctx), config, path, target)
}

func postJSONWithSubmissionKey(ctx context.Context, config providerConfig, path string, body interface{}, target interface{}) error {
	ctx = bindRequestReceipts(ctx)
	if generation.SubmissionKeyFromContext(ctx) == "" {
		if key, ok := ctx.Value(providerSubmissionKeyContext{}).(string); ok {
			ctx = generation.WithSubmissionKey(ctx, key)
		}
	}
	return generation.PostJSONWithSubmissionKey(ctx, config, path, body, target)
}

func getJSON(ctx context.Context, config providerConfig, path string, target interface{}) error {
	return generation.GetJSON(bindRequestReceipts(ctx), config, path, target)
}

func sameProviderOrigin(baseURL string, rawURL string) bool {
	return generation.SameProviderOrigin(baseURL, rawURL)
}

func doBinary(req *http.Request) ([]byte, string, error) {
	return generation.DoBinary(withHTTPRequestRuntime(req))
}

func providerPollingDeadline(ctx context.Context) time.Time {
	return generation.PollingDeadline(ctx)
}

func apiURL(baseURL string, path string) string {
	return generation.APIURL(baseURL, path)
}

func ChannelAPIURL(baseURL string, path string) string {
	return generation.ChannelAPIURL(baseURL, path)
}

func ChannelAPIURLForProtocol(baseURL string, path string, interfaceType model.ChannelInterfaceType) string {
	return generation.ChannelAPIURLForProtocol(baseURL, path, interfaceType)
}

func writeMediaPart(writer *multipart.Writer, field string, media providerMedia) error {
	return generation.WriteMediaPart(writer, field, media)
}

func mediaBytes(media providerMedia) ([]byte, string, error) {
	return generation.MediaBytes(media)
}

func recordProviderRequest(service *Service, req *http.Request, startedAt time.Time, statusCode int, responseBody []byte, requestErr error) {
	if service == nil {
		return
	}
	generation.RecordProviderRequest(service.repo, service.LogAPICall, req, startedAt, statusCode, responseBody, requestErr)
}

func providerRequestErrorDetails(err error) (string, string) {
	return generation.ProviderRequestErrorDetails(err)
}

func safeProviderLogError(err error) string {
	return generation.SafeProviderLogError(err)
}
