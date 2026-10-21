/* Include libc's inline definitions before redirecting fixture reports. Defining
 * putchar on the compiler command line would rename its glibc inline body and
 * still write through putc(stdout), bypassing the external quiet function.
 */
#ifndef MELODICA_API_QUIET_H
#define MELODICA_API_QUIET_H

#include <stdio.h>

int api_quiet_printf(const char *format, ...);
int api_quiet_puts(const char *text);
int api_quiet_fputs(const char *text, FILE *stream);
int api_quiet_putchar(int value);

#define printf api_quiet_printf
#define puts api_quiet_puts
#define fputs api_quiet_fputs
#define putchar api_quiet_putchar

#endif
