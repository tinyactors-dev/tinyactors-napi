/* Dotted event-name interning (ADR 0004). */
#include <string.h>

#include "check.h"
#include "events.h"
#include "system.h"

static ta_str text_of(const char *text) {
    return (ta_str){ .ptr = text, .len = (uint32_t)strlen(text) };
}

static void interns_once_and_formats_back(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    ta_event_name_id first = 0;
    ta_event_name_id again = 0;
    ta_event_name_id other = 0;
    CHECK(tna_event_name_intern(system->core, text_of("user.message.sent"), &first) == TA_OK);
    CHECK(tna_event_name_intern(system->core, text_of("user.message.sent"), &again) == TA_OK);
    CHECK(tna_event_name_intern(system->core, text_of("user.message"), &other) == TA_OK);
    CHECK(first == again);
    CHECK(first != other);
    CHECK(ta_event_name_matches(system->core, first, other));

    char buffer[64];
    uint32_t needed = 0;
    CHECK(ta_event_name_format(system->core, &(ta_event_name_format_params){
                                                 .name = first,
                                                 .buffer = buffer,
                                                 .capacity = sizeof buffer,
                                                 .needed = &needed,
                                             }) == TA_OK);
    CHECK(strcmp(buffer, "user.message.sent") == 0);
    tna_system_free(system);
}

static void refuses_malformed_names(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    ta_event_name_id id = 0;
    const char *bad[] = { "", ".", "a..b", ".a", "a." };
    for (size_t index = 0; index < sizeof bad / sizeof bad[0]; index += 1) {
        CHECK(tna_event_name_intern(system->core, text_of(bad[index]), &id) == TA_ERR_INVALID);
    }
    char deep[2 * (TNA_EVENT_NAME_MAX_DEPTH + 1u)];
    size_t at = 0;
    for (uint32_t segment = 0; segment <= TNA_EVENT_NAME_MAX_DEPTH; segment += 1) {
        deep[at++] = 'x';
        deep[at++] = '.';
    }
    deep[at - 1u] = '\0';
    CHECK(tna_event_name_intern(system->core, text_of(deep), &id) == TA_ERR_INVALID);
    deep[at - 3u] = '\0'; /* one segment fewer: exactly the limit */
    CHECK(tna_event_name_intern(system->core, text_of(deep), &id) == TA_OK);
    tna_system_free(system);
}

int main(void) {
    interns_once_and_formats_back();
    refuses_malformed_names();
    return 0;
}
