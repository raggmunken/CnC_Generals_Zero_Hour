/*
**	Command & Conquer Generals Zero Hour(tm)
**	Copyright 2025 Electronic Arts Inc.
**
**	This program is free software: you can redistribute it and/or modify
**	it under the terms of the GNU General Public License as published by
**	the Free Software Foundation, either version 3 of the License, or
**	(at your option) any later version.
**
**	This program is distributed in the hope that it will be useful,
**	but WITHOUT ANY WARRANTY; without even the implied warranty of
**	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
**	GNU General Public License for more details.
**
**	You should have received a copy of the GNU General Public License
**	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// AIEvalHarness.h
// Batch evaluation support for AI work.
//
// Tuning an AI by playing it yourself does not scale and does not produce
// evidence. This watches a headless match, decides when it is over, appends a
// machine-readable record, and quits so a driver script can run hundreds of
// them and report a win rate.
//
// Enabled with -aiEval <file>. Inert otherwise.

#pragma once

#ifndef _AI_EVAL_HARNESS_H_
#define _AI_EVAL_HARNESS_H_

#include "Lib/BaseType.h"

class Player;

/**
 * Match observer that emits one result record per game.
 *
 * All state is file-static; there is at most one match in flight per process.
 */
class AIEvalHarness
{
public:

	/// True when -aiEval named an output file.
	static Bool isEnabled( void );

	/// Called when a new match begins.
	static void reset( void );

	/// Called once per logic frame. Cheap when disabled or already reported.
	static void update( void );

private:

	/// Append the record and ask the engine to quit.
	static void report( const char *reason, Player *winner );

	/// A player that is actually contesting the match, as opposed to a neutral
	/// or civilian side that never builds anything.
	static Bool isContender( Player *p );
};

#endif // _AI_EVAL_HARNESS_H_
