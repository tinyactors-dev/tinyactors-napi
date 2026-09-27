#include "events.h"

ta_result tna_event_name_intern(ta_system *system, ta_str text, ta_event_name_id *out) {
    if (system == NULL || out == NULL || text.ptr == NULL || text.len == 0) {
        return TA_ERR_INVALID;
    }
    ta_atom atoms[TNA_EVENT_NAME_MAX_DEPTH];
    uint32_t count = 0;
    uint32_t start = 0;
    for (uint32_t index = 0; index <= text.len; index += 1) {
        if (index < text.len && text.ptr[index] != '.') {
            continue;
        }
        if (index == start || count == TNA_EVENT_NAME_MAX_DEPTH) {
            return TA_ERR_INVALID; /* an empty segment, or too many */
        }
        ta_result result = ta_system_intern_atom(system, (ta_str){ .ptr = text.ptr + start, .len = index - start },
                                                 &atoms[count]);
        if (result != TA_OK) {
            return result;
        }
        count += 1u;
        start = index + 1u;
    }
    return ta_event_name_intern(system, &(ta_atom_list){ .atoms = atoms, .count = count }, out);
}
