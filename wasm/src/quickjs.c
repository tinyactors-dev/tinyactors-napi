/* A host on core's quickjs datamodel (datamodel "quickjs"): the calls the
 * addon makes of it (src/host.c, src/effects.c), here as exports. quickjs
 * runs inside this module, its engine allocating from wasi-libc's malloc
 * as the host does; JavaScript makes the values from its CBOR and gives
 * its CBOR to it, one token per call (cbor.c). */
#include "web.h"

void ta_web_quickjs_time(ta_web_host *host) {
    if (host->quickjs != NULL) ta_datamodel_ecmascript_wasm_set_time(ta_web_import_clock(host->id, 2) / 1e6);
}

/* A payload of the value whose CBOR is in the record's words 0-1
 * (ta_datamodel_ecmascript_payload_from_cbor): its handle in words 0-1,
 * one reference, JavaScript's to give core or drop. */
TA_WEB_EXPORT int32_t ta_web_quickjs_payload(ta_web_host *host) {
    uint32_t *word = host->env->record.word;
    ta_payload payload = 0;
    if (host->quickjs == NULL) return TA_ERROR_UNSUPPORTED;
    ta_web_enter(host);
    ta_web_quickjs_time(host);
    ta_status status = ta_datamodel_ecmascript_payload_from_cbor(host->quickjs, ta_web_bytes_at(word, 0), &payload);
    ta_web_leave(host);
    ta_web_set_word64(word, 0, status == TA_OK ? payload : 0);
    return status;
}

/* A payload's value as CBOR (ta_datamodel_ecmascript_payload_to_cbor):
 * its bytes in the record's words 0-1, a view of quickjs's memory until
 * its next call. */
TA_WEB_EXPORT int32_t ta_web_quickjs_cbor(ta_web_host *host, uint32_t low, uint32_t high) {
    ta_bytes cbor = {NULL, 0};
    if (host->quickjs == NULL) return TA_ERROR_UNSUPPORTED;
    ta_web_enter(host);
    ta_status status = ta_datamodel_ecmascript_payload_to_cbor(host->quickjs, (uint64_t)low | (uint64_t)high << 32, &cbor);
    ta_web_leave(host);
    ta_web_set_bytes(host->env->record.word, 0, status == TA_OK ? cbor : (ta_bytes){NULL, 0});
    return status;
}

/* quickjs's state (ta_datamodel_ecmascript_snapshot) in the host's output
 * room, the datamodel's last output (valid until its next call): written
 * into room for the last state's length and a quarter more, once more
 * only when it outgrew that, as the addon writes it. Its bytes in the
 * record's words 0-1. */
TA_WEB_EXPORT int32_t ta_web_quickjs_state(ta_web_host *host) {
    if (host->quickjs == NULL) return TA_ERROR_UNSUPPORTED;
    size_t room = host->quickjs_room + host->quickjs_room / 4 + 4096;
    ta_status status = TA_ERROR_NO_MEMORY;
    ta_buffer out = {NULL, 0, 0};
    ta_web_enter(host);
    for (int attempt = 0; attempt < 2; attempt++) {
        if (room > UINT32_MAX || ta_web_dm_output(host, (uint32_t)room) == 0) {
            status = TA_ERROR_NO_MEMORY;
            break;
        }
        out = (ta_buffer){host->output.pointer, host->output.capacity, 0};
        status = ta_datamodel_ecmascript_snapshot(host->quickjs, &out);
        if (status != TA_ERROR_NO_MEMORY || out.length <= room) break; /* written, or refused */
        room = out.length;                                             /* it outgrew the guess */
    }
    ta_web_leave(host);
    if (status == TA_OK) host->quickjs_room = out.length;
    ta_web_set_bytes(host->env->record.word, 0, status == TA_OK ? (ta_bytes){out.pointer, out.length} : (ta_bytes){NULL, 0});
    return status;
}

/* quickjs's state back (ta_datamodel_ecmascript_restore) from the bytes in
 * the record's words 0-1, after the host's restore attached the charts and
 * before anything runs. */
TA_WEB_EXPORT int32_t ta_web_quickjs_restore(ta_web_host *host) {
    if (host->quickjs == NULL) return TA_ERROR_UNSUPPORTED;
    ta_web_enter(host);
    ta_web_quickjs_time(host);
    ta_status status = ta_datamodel_ecmascript_restore(host->quickjs, ta_web_bytes_at(host->env->record.word, 0));
    ta_web_leave(host);
    return status;
}

/* Why the last hibernation, export or snapshot was TA_ERROR_UNSUPPORTED
 * (ta_datamodel_ecmascript_last_error): its text at the answer, its
 * length in the record's word 0; "" after a success. */
TA_WEB_EXPORT uint32_t ta_web_quickjs_reason(ta_web_host *host) {
    const char *reason = host->quickjs != NULL ? ta_datamodel_ecmascript_last_error(host->quickjs) : NULL;
    uint32_t length = 0;
    if (reason == NULL) reason = "";
    while (reason[length] != '\0') length++; /* a C string: the layer calls no strlen (web-calls-core-and-txml) */
    host->env->record.word[0] = length;
    return ta_web_address(reason);
}

/* host.quickjsHeapBytes: the bytes the engine has allocated (O(1)). */
TA_WEB_EXPORT double ta_web_quickjs_heap_bytes(const ta_web_host *host) {
    return host->quickjs != NULL ? (double)ta_datamodel_ecmascript_heap_bytes(host->quickjs) : -1;
}
