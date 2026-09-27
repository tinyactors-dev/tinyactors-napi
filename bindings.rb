# frozen_string_literal: true

# Binding policy for `mise run bindings` (ADR 0013): the decisions about the
# Node-API control plane that tinyactors-core/include/tinyactors.api.json
# cannot make.
#
# Every public function lands in exactly one category:
# - bound: generated and callable from JavaScript (the default for anything
#   the tables below do not name);
# - bound with a hook (HOOKED_FUNCTIONS): generated, and a hand-written hook
#   in src/hooks.c runs after a successful call so the plumbing sees the
#   change;
# - plumbing-owned (PLUMBING_FUNCTIONS): not callable from JavaScript,
#   because calling it would bypass or break the scheduler;
# - overridden (OVERRIDE_FUNCTIONS): a hand-written function replaces the
#   generated one;
# - skipped (SKIP_FUNCTIONS): C-only utilities and callback-only functions.
#
# Every type is an alias, a handle or view, an enum, a string/bytes value with
# a runtime codec, an adapter the plumbing injects (INJECT_TYPES), overridden
# (OVERRIDE_TYPES), skipped (SKIP_TYPES), or a struct whose codec is
# generated.
#
# The generator fails when an item fits no category, when a bound item needs
# a skipped or plumbing-owned one, and when an entry below matches nothing.
# Keys are File.fnmatch patterns; {a,b} lists alternatives.
module TinyactorsNapiBindings
  HOOKED_FUNCTIONS = {
    'ta_actor_spawn' => { hook: 'created', actor: 'params.out',
                          reason: 'puts the new actor on the runnable queue for bootstrap (step 5)' },
    'ta_actor_load' => { hook: 'created', actor: 'params.out',
                         reason: 'puts the loaded actor on the runnable queue (step 14)' },
    'ta_actor_reconstruct' => { hook: 'created', actor: 'params.out',
                                reason: 'puts the reconstructed actor on the runnable queue (step 14)' },
    'ta_actor_prepare_replacement' => { hook: 'created', actor: 'params.out',
                                        reason: 'puts the prepared actor on the runnable queue (step 14)' },
    'ta_actor_destroy' => { hook: 'removed', actor: 'actor', reason: "drops the actor's mailbox (step 5)" },
    'ta_actor_unload' => { hook: 'unloaded', actor: 'params.actor',
                           reason: "dead-letters the actor's mailbox as unloaded (step 14)" },
    'ta_actor_activate_replacement' => { hook: 'activated', actor: 'params',
                                         reason: "moves the incumbent's waiting mail to the replacement (step 14)" },
    'ta_actor_abandon' => { hook: 'abandoned', actor: 'actor',
                            reason: "settles the send() of the abandoned macrostep and the actor's scheduling (ADR 0026)" }
  }.freeze

  PLUMBING_FUNCTIONS = {
    'ta_actor_{deliver,resume,publish_completion}' => 'the pump delivers and resumes (ADRs 0005, 0007)',
    'ta_actor_offload' => 'unload() offloads into the native offload store, which owns the bytes (core ADR 0074)',
    'ta_system_{dispatch_due,set_time}' => 'the clock belongs to the pump (ADR 0007)',
    'ta_system_set_{external_event_router,actor_directory}' => 'installed at system creation (ADR 0006)',
    'ta_system_set_event_block_cache' => 'sized from scheduling.messageBudget at system creation (core ADR 0069)',
    'ta_system_register_{io,invoker}' => 'reached through hand-written registration (step 13)',
    'ta_system_set_log_sink' => 'reached through hand-written registration (step 13)',
    'ta_system_set_trace_sink' => 'installed by the tracing hook, which hands records to JavaScript (core ADR 0067)',
    'ta_system_set_definition_sink' => 'installed at system creation; frees what the addon keeps per definition (core ADR 0079)',
    'ta_actor_report_invoke' => 'invoker adapters report through the plumbing (step 13)',
    'ta_system_{create,destroy}' => 'the native System owns the ta_system (ADR 0012)',
    'ta_system_visit_actors' => 'paged enumeration is plumbing (ADR 0003, step 9)',
    'ta_event_name_intern' => 'events.{c,h} interns dotted names from text once (ADR 0004)',
    'ta_io_origin_make' => 'I/O origins are made by the plumbing when JavaScript posts with an origin (core ADR 0068)',
    'ta_origin_release' => 'the plumbing releases the origins it makes (core ADR 0068)',
    'ta_io_scope_{open,close}' => 'scopes are opened and closed through hand-written System methods (core ADR 0068)',
    'ta_origin_text' => 'the ta_origin codec renders an origin into the call arena (core ADR 0068)'
  }.freeze

  OVERRIDE_FUNCTIONS = {}.freeze

  SKIP_FUNCTIONS = {
    'ta_arena_*' => 'C memory utility; the call arena belongs to the runtime',
    'ta_tree_*' => 'C construction helper; specs decode straight into the call arena',
    'ta_{value,event,external_delivery}_{retain,release}' => 'C lifetime helpers used by the plumbing',
    'ta_scxml_target_release' => 'the generated binding releases what ta_scxml_target_parse returns',
    'ta_address_{intern,retain,release,view}' =>
      'named addresses cross as family and name text; the ta_actor_ref codec interns and views them (ADR 0006)',
    'ta_actor_id_{slot,generation,make}' => 'actor IDs cross as (slot, generation); the runtime codec splits and joins them (ADR 0002)',
    'ta_dm_host_*' => 'callable only from inside data-model callbacks (step 11)',
    'ta_null_datamodel' => 'the plumbing chooses the data model; it is injected into compile_spec',
    'ta_null_trace_sink' => 'the tracing hook installs it when no JavaScript callback is registered (core ADR 0067)',
    'ta_null_definition_sink' => 'the native System always installs its own definition sink (core ADR 0079)',
    'ta_definition_{import,encode}' => 'src/import.c calls them with the SCXML codec, for define(text, { format: \'scxml\' }) and the debug session\'s encodeDefinition() (ADRs 0019, 0026)'
  }.freeze

  # Types whose codec is hand-written in src/runtime.c.
  OVERRIDE_TYPES = {
    'ta_actor_id' => 'crosses as (slot, generation): two positional numbers at the top level, {slot, generation} inside objects (ADR 0002)',
    'ta_actor_ref' => 'a named ref is an interned ta_address handle; it crosses as family and name text (ADR 0006)',
    'ta_origin' => 'crosses out as {kind, actor | invoke | scope, type, uri}, rendered by core as _event.origintype and _event.origin; a MESSAGE entry is a core view (core ADR 0068); JavaScript never passes one in',
    'ta_value' => 'values cross as value boxes (ADR 0011); undefined is an absent value',
    'ta_expression' => 'source text crosses as a string; a function, literal() or { get, set } is a host expression of the JavaScript data model (ADR 0011)'
  }.freeze

  # Adapter types the plumbing supplies. A field of such a type is not an
  # argument: the runtime fills it. In an output it crosses as described.
  INJECT_TYPES = {
    'ta_allocator' => 'the system allocator (ADR 0014)',
    'ta_datamodel' => "core's null data model, or the JavaScript data model when System.define() selects it; in an output, its SCXML name"
  }.freeze

  SKIP_TYPES = {
    '*_vtable' => 'adapter operations; adapters are hand-written plumbing',
    'ta_{actor_directory,external_event_router,io,invoker,log_sink}' => 'adapters installed by the plumbing',
    'ta_chart_{codec,lowering,src_resolver,expression_printer,span_sink}' => 'chart codec adapters; none is registered yet',
    'ta_actor_directory_*' => 'directory callback arguments (ADR 0006)',
    'ta_{io,invoke}_origin' => 'cross only inside ta_origin, whose hand-written codec renders them (core ADR 0068)',
    'ta_actor_inspector' => 'enumeration is plumbing (ADR 0003)',
    'ta_actor_visit_params' => 'enumeration is plumbing (ADR 0003)',
    'ta_actor_resume_params' => 'the pump resumes actors (ADR 0007)',
    'ta_due_dispatch_params' => 'the clock belongs to the pump (ADR 0007)',
    'ta_external_{delivery,event_submit_params}' => 'router callback arguments (ADR 0006)',
    'ta_invoke_{request,report_params}' => 'invoker plumbing (step 13)',
    'ta_invoker_*_params' => 'invoker callback arguments (step 13)',
    'ta_send' => 'I/O processor callback argument (step 13)',
    'ta_io_text_params' => 'I/O processor callback argument (core ADR 0068)',
    'ta_io_{registration,origin_make,scope_open}_params' => 'arguments of plumbing-owned functions (core ADR 0068)',
    'ta_origin_text_params' => 'argument of a plumbing-owned function (core ADR 0068)',
    'ta_log_record' => 'log sink callback argument (step 13)',
    'ta_trace_{record,sink}' => 'trace sink plumbing: records reach JavaScript through the tracing hook (core ADR 0067)',
    'ta_definition_{sink,event}' => 'definition sink plumbing: the native System keeps it to free per-definition state (core ADR 0079)',
    'ta_named_value' => 'data-model callback argument (step 11)',
    'ta_fault' => 'callback fault record; faults reach JavaScript through hooks (ADR 0008)',
    'ta_datamodel_*_params' => 'data-model callback arguments (step 11)',
    'ta_expression_{host,rejection}' => 'data-model plumbing (step 11)',
    'ta_dm_text_params' => 'data-model callback argument (step 11)',
    'ta_definition_{import,encode}_params' => 'src/import.c fills them; neither call is bound (ADRs 0019, 0026)',
    'ta_chart_{decode,encode}_params' => 'chart codec callback arguments',
    'ta_chart_{codec_info,error,position}' => 'chart codec results; no codec is registered yet',
    'ta_import_error' => 'chart codec result; no codec is registered yet',
    'ta_arena' => 'C memory utility',
    'ta_allocator_free_params' => 'allocator callback argument',
    'ta_tree{,_list,_list_layout}' => 'C construction helper',
    'ta_system_config' => 'the native System creates the ta_system (ADR 0012)'
  }.freeze

  # 64-bit integers cross as JavaScript bigints, except these, which cross as
  # numbers because their values stay far below 2^53.
  NUMBER_TYPES = {
    'ta_time' => 'milliseconds of logical time; 2^53 ms is 285,000 years',
    'size_t' => 'byte counts'
  }.freeze

  # Handles whose objects core reclaims itself when the system is destroyed,
  # so close() must not release them again (ADR 0012).
  RECLAIMED_BY_CORE = {
    'definition' => 'core reclaims compiled definitions that were never registered'
  }.freeze

  # A parameter with this name that points at a struct is flattened into
  # positional arguments (ADR 0013).
  FLATTEN_PARAMETER = 'params'

  # TinyactorsErrorCode for a ta_result symbol whose default spelling (drop
  # "err_", then "_" becomes "-") is not the one index.d.ts uses.
  RESULT_CODES = {
    'err_nomem' => 'out-of-memory'
  }.freeze
end
