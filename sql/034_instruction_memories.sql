-- Standing do / don't rules ("never mention the price") are stored as memory_type 'instruction'.
alter table memories drop constraint if exists memories_memory_type_check;
alter table memories add constraint memories_memory_type_check
  check (memory_type in ('semantic', 'episodic', 'emotional', 'working', 'instruction'));
