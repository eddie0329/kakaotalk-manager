#include <node_api.h>
#include <stdlib.h>

extern char* reply_note_read(const char* request);

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char* request;
  char* result;
} ReadWork;

static void Execute(napi_env env, void* data) {
  ReadWork* work = (ReadWork*)data;
  work->result = reply_note_read(work->request);
}

static void Complete(napi_env env, napi_status status, void* data) {
  ReadWork* work = (ReadWork*)data;
  napi_value value;
  if (status == napi_ok && work->result) {
    napi_create_string_utf8(env, work->result, NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, work->deferred, value);
  } else {
    napi_value message;
    napi_create_string_utf8(env, "접근성 읽기 작업을 완료하지 못했습니다.", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &value);
    napi_reject_deferred(env, work->deferred, value);
  }
  free(work->result);
  free(work->request);
  napi_delete_async_work(env, work->work);
  free(work);
}

static napi_value Request(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, NULL, "request requires a JSON string");
    return NULL;
  }
  size_t size = 0;
  napi_get_value_string_utf8(env, args[0], NULL, 0, &size);
  if (size > 98304) { napi_throw_range_error(env, NULL, "request too large"); return NULL; }
  ReadWork* work = calloc(1, sizeof(ReadWork));
  if (!work) { napi_throw_error(env, NULL, "allocation failed"); return NULL; }
  work->request = malloc(size + 1);
  if (!work->request) { free(work); napi_throw_error(env, NULL, "allocation failed"); return NULL; }
  napi_get_value_string_utf8(env, args[0], work->request, size + 1, &size);
  napi_value promise, resource;
  napi_create_promise(env, &work->deferred, &promise);
  napi_create_string_utf8(env, "ReplyNoteAccessibilityRead", NAPI_AUTO_LENGTH, &resource);
  napi_create_async_work(env, NULL, resource, Execute, Complete, work, &work->work);
  napi_queue_async_work(env, work->work);
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "request", NAPI_AUTO_LENGTH, Request, NULL, &fn);
  napi_set_named_property(env, exports, "request", fn);
  return exports;
}

NAPI_MODULE(reply_accessibility, Init)
